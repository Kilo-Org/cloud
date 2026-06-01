import 'server-only';

import { addDays, addHours } from 'date-fns';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import { getCodingPlanPrice } from '@/lib/coding-plans/pricing';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { sentryLogger } from '@/lib/utils.server';
import {
  byok_api_keys,
  coding_plan_key_inventory,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import type * as schema from '@kilocode/db/schema';

const logInfo = sentryLogger('coding-plans-billing-cron', 'info');
const logError = sentryLogger('coding-plans-billing-cron', 'error');
const BILLING_LIFECYCLE_SWEEP_LIMIT = 1_000;

export type CodingPlanCronSummary = {
  renewals: number;
  renewals_skipped_duplicate: number;
  canceled_at_period_end: number;
  canceled_insufficient_balance: number;
  past_due_started: number;
  auto_top_up_triggered: number;
  errors: number;
};

type RenewalRow = {
  id: string;
  user_id: string;
  installed_byok_key_id: string | null;
  key_inventory_id: string | null;
  plan_id: string;
  status: 'active' | 'past_due';
  cost_microdollars: number;
  billing_period_days: number;
  current_period_end: string;
  credit_renewal_at: string;
  cancel_at_period_end: boolean;
  payment_grace_expires_at: string | null;
  total_microdollars_acquired: number;
  microdollars_used: number;
  auto_top_up_enabled: boolean;
  next_credit_expiration_at: string | null;
  user_updated_at: string;
};

type RenewalResult = 'renewed' | 'duplicate' | 'past_due_started' | 'waiting' | 'terminated';

function emptySummary(): CodingPlanCronSummary {
  return {
    renewals: 0,
    renewals_skipped_duplicate: 0,
    canceled_at_period_end: 0,
    canceled_insufficient_balance: 0,
    past_due_started: 0,
    auto_top_up_triggered: 0,
    errors: 0,
  };
}

export async function runCodingPlanBillingLifecycleCron(
  database: PostgresJsDatabase<typeof schema>
): Promise<CodingPlanCronSummary> {
  const summary = emptySummary();
  const nowIso = new Date().toISOString();

  try {
    await sweepCancelAtPeriodEnd(database, nowIso, summary);
  } catch (error) {
    summary.errors++;
    logError('Cancel-at-period-end sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await sweepRenewals(database, nowIso, summary);
  } catch (error) {
    summary.errors++;
    logError('Renewal sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo('Coding plan billing cron completed', summary);
  return summary;
}

async function sweepCancelAtPeriodEnd(
  database: PostgresJsDatabase<typeof schema>,
  nowIso: string,
  summary: CodingPlanCronSummary
): Promise<void> {
  const rows = await database
    .select({
      id: coding_plan_subscriptions.id,
      installed_byok_key_id: coding_plan_subscriptions.installed_byok_key_id,
      key_inventory_id: coding_plan_subscriptions.key_inventory_id,
    })
    .from(coding_plan_subscriptions)
    .where(
      and(
        eq(coding_plan_subscriptions.status, 'active'),
        eq(coding_plan_subscriptions.cancel_at_period_end, true),
        lte(coding_plan_subscriptions.current_period_end, nowIso)
      )
    )
    .orderBy(asc(coding_plan_subscriptions.current_period_end), asc(coding_plan_subscriptions.id))
    .limit(BILLING_LIFECYCLE_SWEEP_LIMIT);

  for (const row of rows) {
    try {
      await database.transaction(async tx => {
        await tx
          .update(coding_plan_subscriptions)
          .set({
            status: 'canceled',
            canceled_at: nowIso,
            cancellation_reason: 'user_canceled',
            cancel_at_period_end: false,
            installed_byok_key_id: null,
          })
          .where(
            and(
              eq(coding_plan_subscriptions.id, row.id),
              eq(coding_plan_subscriptions.status, 'active')
            )
          );
        if (row.installed_byok_key_id) {
          await tx
            .delete(byok_api_keys)
            .where(
              and(
                eq(byok_api_keys.id, row.installed_byok_key_id),
                eq(byok_api_keys.management_source, 'coding_plan')
              )
            );
        }
        if (row.key_inventory_id) {
          await tx
            .update(coding_plan_key_inventory)
            .set({
              status: 'revocation_pending',
              encrypted_api_key: null,
              revocation_requested_at: nowIso,
            })
            .where(eq(coding_plan_key_inventory.id, row.key_inventory_id));
        }
      });
      summary.canceled_at_period_end++;
    } catch (error) {
      summary.errors++;
      logError('Failed to end canceled coding plan access', {
        subscriptionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function sweepRenewals(
  database: PostgresJsDatabase<typeof schema>,
  nowIso: string,
  summary: CodingPlanCronSummary
): Promise<void> {
  const rows = await database
    .select({
      id: coding_plan_subscriptions.id,
      user_id: coding_plan_subscriptions.user_id,
      installed_byok_key_id: coding_plan_subscriptions.installed_byok_key_id,
      key_inventory_id: coding_plan_subscriptions.key_inventory_id,
      plan_id: coding_plan_subscriptions.plan_id,
      status: coding_plan_subscriptions.status,
      cost_microdollars: coding_plan_subscriptions.cost_microdollars,
      billing_period_days: coding_plan_subscriptions.billing_period_days,
      current_period_end: coding_plan_subscriptions.current_period_end,
      credit_renewal_at: coding_plan_subscriptions.credit_renewal_at,
      cancel_at_period_end: coding_plan_subscriptions.cancel_at_period_end,
      payment_grace_expires_at: coding_plan_subscriptions.payment_grace_expires_at,
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
        inArray(coding_plan_subscriptions.status, ['active', 'past_due']),
        eq(coding_plan_subscriptions.cancel_at_period_end, false),
        lte(coding_plan_subscriptions.credit_renewal_at, nowIso)
      )
    )
    .orderBy(asc(coding_plan_subscriptions.credit_renewal_at), asc(coding_plan_subscriptions.id))
    .limit(BILLING_LIFECYCLE_SWEEP_LIMIT);

  for (const selectedRow of rows) {
    const row: RenewalRow = {
      ...selectedRow,
      status: selectedRow.status === 'past_due' ? 'past_due' : 'active',
    };
    try {
      const result = await processRenewal(database, row, nowIso);
      if (result === 'renewed') {
        summary.renewals++;
        try {
          await maybeIssueKiloPassBonusFromUsageThreshold({
            kiloUserId: row.user_id,
            nowIso,
          });
        } catch (error) {
          logError('Kilo Pass bonus evaluation failed after coding plan renewal', {
            user_id: row.user_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (result === 'duplicate') {
        summary.renewals_skipped_duplicate++;
      } else if (result === 'past_due_started') {
        summary.past_due_started++;
        try {
          await maybePerformAutoTopUp({
            id: row.user_id,
            total_microdollars_acquired: row.total_microdollars_acquired,
            microdollars_used: row.microdollars_used,
            auto_top_up_enabled: row.auto_top_up_enabled,
            next_credit_expiration_at: row.next_credit_expiration_at,
            updated_at: row.user_updated_at,
          });
        } catch (error) {
          logError('Auto top-up attempt failed during coding plan recovery', {
            user_id: row.user_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Counts auto-top-up attempts that were triggered, not successful charges.
        // maybePerformAutoTopUp is best-effort, so the attempt still counts when it
        // throws (the failure is logged above). This matches spec rule 5.5: at most
        // one auto-top-up attempt is triggered per due term, regardless of outcome.
        summary.auto_top_up_triggered++;
      } else if (result === 'terminated') {
        summary.canceled_insufficient_balance++;
      }
    } catch (error) {
      summary.errors++;
      logError('Failed to process coding plan renewal', {
        subscriptionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function processRenewal(
  database: PostgresJsDatabase<typeof schema>,
  selectedRow: RenewalRow,
  nowIso: string
): Promise<RenewalResult> {
  // Renewal processing has one durable outcome per due term, guarded by row locks
  // and an idempotency key: charge and extend, start a single auto-top-up grace
  // window, wait for in-flight grace recovery, or terminate and queue revocation.
  return database.transaction(async tx => {
    await tx.execute(
      sql`SELECT id FROM coding_plan_subscriptions WHERE id = ${selectedRow.id} FOR UPDATE`
    );
    await tx.execute(
      sql`SELECT id FROM kilocode_users WHERE id = ${selectedRow.user_id} FOR UPDATE`
    );
    const [row] = await tx
      .select({
        id: coding_plan_subscriptions.id,
        user_id: coding_plan_subscriptions.user_id,
        installed_byok_key_id: coding_plan_subscriptions.installed_byok_key_id,
        key_inventory_id: coding_plan_subscriptions.key_inventory_id,
        plan_id: coding_plan_subscriptions.plan_id,
        status: coding_plan_subscriptions.status,
        cost_microdollars: coding_plan_subscriptions.cost_microdollars,
        billing_period_days: coding_plan_subscriptions.billing_period_days,
        credit_renewal_at: coding_plan_subscriptions.credit_renewal_at,
        cancel_at_period_end: coding_plan_subscriptions.cancel_at_period_end,
        payment_grace_expires_at: coding_plan_subscriptions.payment_grace_expires_at,
        microdollars_used: kilocode_users.microdollars_used,
        auto_top_up_enabled: kilocode_users.auto_top_up_enabled,
      })
      .from(coding_plan_subscriptions)
      .innerJoin(kilocode_users, eq(coding_plan_subscriptions.user_id, kilocode_users.id))
      .where(eq(coding_plan_subscriptions.id, selectedRow.id))
      .limit(1);
    if (!row || row.status === 'canceled' || row.cancel_at_period_end) {
      return 'waiting';
    }

    const renewalKey = `renewal:${row.id}:${row.credit_renewal_at}`;
    const [existingTerm] = await tx
      .select({ id: coding_plan_terms.id })
      .from(coding_plan_terms)
      .where(
        and(
          eq(coding_plan_terms.user_id, row.user_id),
          eq(coding_plan_terms.plan_id, row.plan_id),
          eq(coding_plan_terms.idempotency_key, renewalKey)
        )
      )
      .limit(1);
    if (existingTerm) {
      return 'duplicate';
    }

    const { rows: chargedUsers } = await tx.execute(sql`
      UPDATE kilocode_users
      SET microdollars_used = microdollars_used + ${row.cost_microdollars}
      WHERE id = ${row.user_id}
        AND total_microdollars_acquired - microdollars_used >= ${row.cost_microdollars}
      RETURNING id
    `);
    if (chargedUsers.length > 0) {
      const newPeriodEnd = addDays(
        new Date(row.credit_renewal_at),
        row.billing_period_days
      ).toISOString();
      const transactionId = crypto.randomUUID();
      const plan = getCodingPlanPrice(row.plan_id);
      const renewalDescription = plan
        ? `Coding plan renewal: ${plan.providerName} ${plan.name}`
        : 'Coding plan renewal';
      await tx.insert(credit_transactions).values({
        id: transactionId,
        kilo_user_id: row.user_id,
        amount_microdollars: -row.cost_microdollars,
        is_free: false,
        description: renewalDescription,
        credit_category: `coding-plan:${renewalKey}`,
        check_category_uniqueness: true,
        original_baseline_microdollars_used: row.microdollars_used,
      });
      await tx.insert(coding_plan_terms).values({
        subscription_id: row.id,
        user_id: row.user_id,
        plan_id: row.plan_id,
        kind: 'renewal',
        idempotency_key: renewalKey,
        period_start: row.credit_renewal_at,
        period_end: newPeriodEnd,
        cost_microdollars: row.cost_microdollars,
        credit_transaction_id: transactionId,
      });
      await tx
        .update(coding_plan_subscriptions)
        .set({
          status: 'active',
          current_period_start: row.credit_renewal_at,
          current_period_end: newPeriodEnd,
          credit_renewal_at: newPeriodEnd,
          past_due_started_at: null,
          payment_grace_expires_at: null,
          auto_top_up_attempted_for_due: null,
        })
        .where(eq(coding_plan_subscriptions.id, row.id));
      return 'renewed';
    }

    if (row.status === 'active' && row.auto_top_up_enabled) {
      await tx
        .update(coding_plan_subscriptions)
        .set({
          status: 'past_due',
          past_due_started_at: nowIso,
          payment_grace_expires_at: addHours(new Date(row.credit_renewal_at), 24).toISOString(),
          auto_top_up_attempted_for_due: row.credit_renewal_at,
        })
        .where(eq(coding_plan_subscriptions.id, row.id));
      return 'past_due_started';
    }

    if (
      row.status === 'past_due' &&
      row.payment_grace_expires_at &&
      new Date(row.payment_grace_expires_at) > new Date(nowIso)
    ) {
      return 'waiting';
    }

    await tx
      .update(coding_plan_subscriptions)
      .set({
        status: 'canceled',
        canceled_at: nowIso,
        cancellation_reason: 'insufficient_credits',
        installed_byok_key_id: null,
        past_due_started_at: null,
        payment_grace_expires_at: null,
        auto_top_up_attempted_for_due: null,
      })
      .where(eq(coding_plan_subscriptions.id, row.id));
    if (row.installed_byok_key_id) {
      await tx
        .delete(byok_api_keys)
        .where(
          and(
            eq(byok_api_keys.id, row.installed_byok_key_id),
            eq(byok_api_keys.management_source, 'coding_plan')
          )
        );
    }
    if (row.key_inventory_id) {
      await tx
        .update(coding_plan_key_inventory)
        .set({
          status: 'revocation_pending',
          encrypted_api_key: null,
          revocation_requested_at: nowIso,
        })
        .where(eq(coding_plan_key_inventory.id, row.key_inventory_id));
    }
    return 'terminated';
  });
}
