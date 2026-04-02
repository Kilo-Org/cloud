import 'server-only';

import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { addDays, format } from 'date-fns';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@kilocode/db/schema';
import {
  byok_api_keys,
  coding_plan_subscriptions,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('coding-plans-billing-cron', 'info');
const logError = sentryLogger('coding-plans-billing-cron', 'error');

export type CodingPlanCronSummary = {
  renewals: number;
  renewals_skipped_duplicate: number;
  canceled_at_period_end: number;
  canceled_insufficient_balance: number;
  auto_top_up_triggered: number;
  errors: number;
};

function emptySummary(): CodingPlanCronSummary {
  return {
    renewals: 0,
    renewals_skipped_duplicate: 0,
    canceled_at_period_end: 0,
    canceled_insufficient_balance: 0,
    auto_top_up_triggered: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Main cron entry point
// ---------------------------------------------------------------------------

export async function runCodingPlanBillingLifecycleCron(
  database: PostgresJsDatabase<typeof schema>
): Promise<CodingPlanCronSummary> {
  const summary = emptySummary();
  const nowIso = new Date().toISOString();

  // Sweep 1: Cancel-at-period-end subscriptions whose period has elapsed
  try {
    await sweepCancelAtPeriodEnd(database, nowIso, summary);
  } catch (error) {
    summary.errors++;
    logError('Sweep 1 (cancel-at-period-end) failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Sweep 2: Renew active subscriptions whose credit_renewal_at has passed
  try {
    await sweepRenewals(database, nowIso, summary);
  } catch (error) {
    summary.errors++;
    logError('Sweep 2 (renewals) failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo('Coding plan billing cron completed', summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Sweep 1: Cancel at period end
// ---------------------------------------------------------------------------

async function sweepCancelAtPeriodEnd(
  database: PostgresJsDatabase<typeof schema>,
  nowIso: string,
  summary: CodingPlanCronSummary
): Promise<void> {
  const rows = await database
    .select({
      id: coding_plan_subscriptions.id,
      user_id: coding_plan_subscriptions.user_id,
      provider_id: coding_plan_subscriptions.provider_id,
      byok_key_id: coding_plan_subscriptions.byok_key_id,
    })
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.status, 'active'),
        eq(coding_plan_subscriptions.cancel_at_period_end, true),
        lte(coding_plan_subscriptions.current_period_end, nowIso)
      )
    );

  for (const row of rows) {
    try {
      await database.transaction(async tx => {
        await tx
          .update(coding_plan_subscriptions)
          .set({
            status: 'canceled',
            canceled_at: sql`now()`,
            cancel_at_period_end: false,
            byok_key_id: null,
          })
          .where(eq(coding_plan_subscriptions.id, row.id));

        // Spec §5.1: Remove BYOK key from Kilo, do NOT revoke with upstream
        if (row.byok_key_id) {
          await tx.delete(byok_api_keys).where(eq(byok_api_keys.id, row.byok_key_id));
        }
      });

      summary.canceled_at_period_end++;
      logInfo('Coding plan canceled at period end', {
        user_id: row.user_id,
        providerId: row.provider_id,
      });
    } catch (error) {
      summary.errors++;
      logError('Failed to cancel coding plan at period end', {
        subscriptionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep 2: Renewals
// ---------------------------------------------------------------------------

async function sweepRenewals(
  database: PostgresJsDatabase<typeof schema>,
  nowIso: string,
  summary: CodingPlanCronSummary
): Promise<void> {
  // Select active subscriptions due for renewal (not pending cancellation)
  const rows = await database
    .select({
      id: coding_plan_subscriptions.id,
      user_id: coding_plan_subscriptions.user_id,
      provider_id: coding_plan_subscriptions.provider_id,
      byok_key_id: coding_plan_subscriptions.byok_key_id,
      cost_microdollars: coding_plan_subscriptions.cost_microdollars,
      billing_period_days: coding_plan_subscriptions.billing_period_days,
      credit_renewal_at: coding_plan_subscriptions.credit_renewal_at,
      auto_top_up_triggered_for_period: coding_plan_subscriptions.auto_top_up_triggered_for_period,
      // User balance fields
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      auto_top_up_enabled: kilocode_users.auto_top_up_enabled,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      user_updated_at: kilocode_users.updated_at,
    })
    .from(coding_plan_subscriptions)
    .innerJoin(kilocode_users, eq(coding_plan_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(coding_plan_subscriptions.status, 'active'),
        eq(coding_plan_subscriptions.cancel_at_period_end, false),
        lte(coding_plan_subscriptions.credit_renewal_at, nowIso)
      )
    );

  for (const row of rows) {
    try {
      await processRenewal(database, row, summary);
    } catch (error) {
      summary.errors++;
      logError('Failed to process coding plan renewal', {
        subscriptionId: row.id,
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

type RenewalRow = {
  id: string;
  user_id: string;
  provider_id: string;
  byok_key_id: string | null;
  cost_microdollars: number;
  billing_period_days: number;
  credit_renewal_at: string | null;
  auto_top_up_triggered_for_period: string | null;
  total_microdollars_acquired: number;
  microdollars_used: number;
  auto_top_up_enabled: boolean;
  next_credit_expiration_at: string | null;
  user_updated_at: string;
};

async function processRenewal(
  database: PostgresJsDatabase<typeof schema>,
  row: RenewalRow,
  summary: CodingPlanCronSummary
): Promise<void> {
  const {
    user_id: userId,
    credit_renewal_at: renewalAt,
    cost_microdollars: costMicrodollars,
  } = row;
  if (!renewalAt) return;

  const balance = row.total_microdollars_acquired - row.microdollars_used;

  if (balance >= costMicrodollars) {
    // Sufficient balance: deduct and advance
    const periodKey = format(new Date(renewalAt), 'yyyy-MM');
    const deductionCategory = `coding-plan:${row.provider_id}:${row.id}:${periodKey}`;
    const newPeriodEnd = addDays(new Date(renewalAt), row.billing_period_days).toISOString();
    let deductionIsNew = false;

    await database.transaction(async tx => {
      const deductionResult = await tx
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: userId,
          amount_microdollars: -costMicrodollars,
          is_free: false,
          description: `Coding plan renewal: ${row.provider_id}`,
          credit_category: deductionCategory,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: row.microdollars_used,
        })
        .onConflictDoNothing();

      deductionIsNew = (deductionResult.rowCount ?? 0) > 0;
      if (!deductionIsNew) return;

      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));

      await tx
        .update(coding_plan_subscriptions)
        .set({
          current_period_start: renewalAt,
          current_period_end: newPeriodEnd,
          credit_renewal_at: newPeriodEnd,
          auto_top_up_triggered_for_period: null,
        })
        .where(eq(coding_plan_subscriptions.id, row.id));
    });

    if (!deductionIsNew) {
      summary.renewals_skipped_duplicate++;
      logInfo('Coding plan renewal: skipped duplicate', {
        user_id: userId,
        deductionCategory,
      });
      return;
    }

    // Post-transaction bonus evaluation
    try {
      await maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: userId,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      logError('Kilo Pass bonus evaluation failed after coding plan renewal', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    summary.renewals++;
    logInfo('Coding plan renewal succeeded', {
      user_id: userId,
      providerId: row.provider_id,
      costMicrodollars,
      newPeriodEnd,
    });
  } else {
    // Insufficient balance

    // Try auto-top-up if enabled and not already triggered for this period
    if (row.auto_top_up_enabled && !row.auto_top_up_triggered_for_period) {
      // Compare-and-set: only set marker if still NULL (prevents concurrent triggers)
      const markerResult = await database
        .update(coding_plan_subscriptions)
        .set({ auto_top_up_triggered_for_period: renewalAt })
        .where(
          and(
            eq(coding_plan_subscriptions.id, row.id),
            isNull(coding_plan_subscriptions.auto_top_up_triggered_for_period)
          )
        );

      if ((markerResult.rowCount ?? 0) === 0) {
        // Another cron worker already set the marker — skip
        return;
      }

      try {
        await maybePerformAutoTopUp({
          id: userId,
          total_microdollars_acquired: row.total_microdollars_acquired,
          microdollars_used: row.microdollars_used,
          auto_top_up_enabled: row.auto_top_up_enabled,
          next_credit_expiration_at: row.next_credit_expiration_at,
          updated_at: row.user_updated_at,
        });
      } catch (error) {
        logError('Auto top-up trigger failed during coding plan renewal', {
          user_id: userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      summary.auto_top_up_triggered++;
      logInfo('Coding plan renewal: auto top-up triggered, skipping', {
        user_id: userId,
      });
      return;
    }

    // No grace period: cancel immediately and remove BYOK key
    await database.transaction(async tx => {
      await tx
        .update(coding_plan_subscriptions)
        .set({
          status: 'canceled',
          canceled_at: sql`now()`,
          byok_key_id: null,
          auto_top_up_triggered_for_period: null,
        })
        .where(eq(coding_plan_subscriptions.id, row.id));

      if (row.byok_key_id) {
        await tx.delete(byok_api_keys).where(eq(byok_api_keys.id, row.byok_key_id));
      }
    });

    summary.canceled_insufficient_balance++;
    logInfo('Coding plan canceled: insufficient balance', {
      user_id: userId,
      providerId: row.provider_id,
      balance,
      costMicrodollars,
    });
  }
}
