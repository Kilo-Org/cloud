import 'server-only';

import { and, eq, lte, isNull, inArray, sql, or } from 'drizzle-orm';
import { addMonths, format } from 'date-fns';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@kilocode/db/schema';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
  kilocode_users,
  credit_transactions,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { DrizzleTransaction } from '@/lib/drizzle';
import {
  KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS,
  KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS,
} from '@/lib/kiloclaw/constants';
import {
  getProjectedKiloPassBonus,
  evaluateKiloPassBonusAfterDeduction,
} from '@/lib/kiloclaw/kilo-pass-integration';
import { triggerAutoTopUpForKiloClaw } from '@/lib/autoTopUp';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { send as sendEmail } from '@/lib/email';
import type { TemplateName } from '@/lib/email';
import { NEXTAUTH_URL, KILOCLAW_BILLING_ENFORCEMENT } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('kiloclaw-credit-billing', 'info');
const logError = sentryLogger('kiloclaw-credit-billing', 'error');

export type CreditRenewalSweepSummary = {
  renewals: number;
  cancellations: number;
  past_due: number;
  auto_top_up_triggered: number;
  recoveries: number;
  plan_switches: number;
  auto_resumes: number;
  errors: number;
};

/** Standard bills monthly (1 month), commit bills every 6 months ($54/6mo). */
function periodLengthMonths(plan: 'commit' | 'standard'): number {
  return plan === 'commit' ? 6 : 1;
}

/** Returns the cost in microdollars for one billing period of the given plan. */
function planCostMicrodollars(plan: 'commit' | 'standard'): number {
  return plan === 'commit'
    ? KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS
    : KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS;
}

/** Builds the idempotency credit_category key for a given plan and renewal date. */
function buildCreditCategory(plan: 'commit' | 'standard', renewalDate: Date): string {
  const periodKey = format(renewalDate, 'yyyy-MM');
  const prefix = plan === 'commit' ? 'kiloclaw-subscription-commit' : 'kiloclaw-subscription';
  return `${prefix}:${periodKey}`;
}

// ---------------------------------------------------------------------------
// enrollWithCredits
// ---------------------------------------------------------------------------

export async function enrollWithCredits(
  userId: string,
  plan: 'commit' | 'standard'
): Promise<void> {
  // 1. Guard: check existing subscription
  const [existingSub] = await db
    .select({
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);

  if (existingSub && existingSub.status !== 'trialing' && existingSub.status !== 'canceled') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Cannot enroll: existing subscription is active, past-due, or unpaid',
    });
  }

  // 2. Compute cost
  const cost = planCostMicrodollars(plan);

  // 3. Effective balance check
  const [userRow] = await db
    .select({
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!userRow) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  }

  const currentBalance =
    (userRow.total_microdollars_acquired ?? 0) - (userRow.microdollars_used ?? 0);
  const projectedBonus = await getProjectedKiloPassBonus(userId, cost);
  const effectiveBalance = currentBalance + projectedBonus;

  if (effectiveBalance < cost) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Insufficient credit balance',
    });
  }

  // 4. Check if previously suspended (before mutation)
  const wasSuspended = !!existingSub?.suspended_at;

  // 5. Compute billing period
  const now = new Date(Date.now());
  const periodStart = now.toISOString();
  const periodEnd = addMonths(now, periodLengthMonths(plan)).toISOString();
  const commitEndsAt = plan === 'commit' ? addMonths(now, 6).toISOString() : null;

  // 6. Build idempotency key
  const creditCategory = buildCreditCategory(plan, now);

  // 7. Transaction: deduction + subscription upsert
  await db.transaction(async (tx: DrizzleTransaction) => {
    // a. Insert negative credit transaction (idempotent via unique category)
    const insertResult = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: userId,
        amount_microdollars: -cost,
        is_free: false,
        description: `KiloClaw ${plan} subscription`,
        credit_category: creditCategory,
        check_category_uniqueness: true,
      })
      .onConflictDoNothing();

    if (insertResult.rowCount === 0) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Duplicate enrollment attempt' });
    }

    // b. Decrement total_microdollars_acquired
    await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${cost}`,
      })
      .where(eq(kilocode_users.id, userId));

    // c. Upsert subscription
    // Clears past_due_since but does NOT clear suspended_at or destruction_deadline
    // (those are cleared by auto-resume below).
    await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        plan,
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: null,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        credit_renewal_at: periodEnd,
        commit_ends_at: commitEndsAt,
        cancel_at_period_end: false,
        past_due_since: null,
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.user_id,
        set: {
          plan,
          status: 'active',
          payment_source: 'credits',
          stripe_subscription_id: null,
          stripe_schedule_id: null,
          scheduled_plan: null,
          scheduled_by: null,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          credit_renewal_at: periodEnd,
          commit_ends_at: commitEndsAt,
          cancel_at_period_end: false,
          past_due_since: null,
        },
      });
  });

  // 8. Post-commit: Kilo Pass bonus evaluation
  try {
    await evaluateKiloPassBonusAfterDeduction(userId, cost);
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after enrollment', { userId, error });
  }

  // 9. Auto-resume if previously suspended
  if (wasSuspended) {
    await autoResumeIfSuspended(userId);
  }
}

// ---------------------------------------------------------------------------
// autoResumeIfSuspended
// ---------------------------------------------------------------------------

export async function autoResumeIfSuspended(kiloUserId: string): Promise<void> {
  const [activeInstance] = await db
    .select({ id: kiloclaw_instances.id })
    .from(kiloclaw_instances)
    .where(and(eq(kiloclaw_instances.user_id, kiloUserId), isNull(kiloclaw_instances.destroyed_at)))
    .limit(1);

  if (activeInstance) {
    try {
      const client = new KiloClawInternalClient();
      await client.start(kiloUserId);
    } catch (startError) {
      logError('Failed to auto-resume instance', {
        user_id: kiloUserId,
        error: startError instanceof Error ? startError.message : String(startError),
      });
    }
  }

  // Clear suspension/destruction cycle emails + credit renewal failed.
  // Trial and earlybird warnings are one-time events and must NOT be cleared.
  const resettableEmailTypes = [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
    'claw_credit_renewal_failed',
  ];
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
      )
    );

  await db
    .update(kiloclaw_subscriptions)
    .set({ suspended_at: null, destruction_deadline: null })
    .where(eq(kiloclaw_subscriptions.user_id, kiloUserId));
}

// ---------------------------------------------------------------------------
// trySendEmail (private)
// ---------------------------------------------------------------------------

async function trySendEmail(
  database: NodePgDatabase<typeof schema>,
  userId: string,
  userEmail: string,
  emailType: string,
  templateName: TemplateName,
  templateVars: Record<string, string>
): Promise<boolean> {
  const result = await database
    .insert(kiloclaw_email_log)
    .values({ user_id: userId, email_type: emailType })
    .onConflictDoNothing();
  if (result.rowCount === 0) return false;
  try {
    await sendEmail({ to: userEmail, templateName, templateVars });
  } catch (error) {
    try {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(eq(kiloclaw_email_log.user_id, userId), eq(kiloclaw_email_log.email_type, emailType))
        );
    } catch (deleteError) {
      console.error(
        '[credit-billing] Failed to clean up email log row after send failure:',
        deleteError,
        { userId, emailType }
      );
    }
    throw error;
  }
  return true;
}

// ---------------------------------------------------------------------------
// runCreditRenewalSweep
// ---------------------------------------------------------------------------

export async function runCreditRenewalSweep(
  database: NodePgDatabase<typeof schema>
): Promise<CreditRenewalSweepSummary> {
  const summary: CreditRenewalSweepSummary = {
    renewals: 0,
    cancellations: 0,
    past_due: 0,
    auto_top_up_triggered: 0,
    recoveries: 0,
    plan_switches: 0,
    auto_resumes: 0,
    errors: 0,
  };

  if (!KILOCLAW_BILLING_ENFORCEMENT) return summary;

  const now = new Date(Date.now()).toISOString();
  const clawUrl = `${NEXTAUTH_URL}/claw`;

  // Select qualifying rows: credit-funded, active or past_due, renewal due
  const rows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      status: kiloclaw_subscriptions.status,
      plan: kiloclaw_subscriptions.plan,
      cancel_at_period_end: kiloclaw_subscriptions.cancel_at_period_end,
      current_period_start: kiloclaw_subscriptions.current_period_start,
      current_period_end: kiloclaw_subscriptions.current_period_end,
      credit_renewal_at: kiloclaw_subscriptions.credit_renewal_at,
      commit_ends_at: kiloclaw_subscriptions.commit_ends_at,
      past_due_since: kiloclaw_subscriptions.past_due_since,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
      auto_top_up_triggered_for_period: kiloclaw_subscriptions.auto_top_up_triggered_for_period,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      auto_top_up_enabled: kilocode_users.auto_top_up_enabled,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.payment_source, 'credits'),
        or(
          eq(kiloclaw_subscriptions.status, 'active'),
          eq(kiloclaw_subscriptions.status, 'past_due')
        ),
        lte(kiloclaw_subscriptions.credit_renewal_at, now)
      )
    );

  for (const row of rows) {
    try {
      // Cancel-at-period-end → set canceled, skip deduction
      if (row.cancel_at_period_end) {
        await database
          .update(kiloclaw_subscriptions)
          .set({
            status: 'canceled',
            cancel_at_period_end: false,
            auto_top_up_triggered_for_period: null,
          })
          .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
        summary.cancellations++;
        continue;
      }

      // Apply scheduled plan change if current period has ended
      let effectivePlan: 'commit' | 'standard' = row.plan === 'commit' ? 'commit' : 'standard';
      if (row.scheduled_plan && row.current_period_end) {
        const periodEndTime = new Date(row.current_period_end).getTime();
        if (periodEndTime <= Date.now()) {
          effectivePlan = row.scheduled_plan;
          const planUpdateFields: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
            plan: effectivePlan,
            scheduled_plan: null,
            scheduled_by: null,
          };
          if (effectivePlan === 'commit') {
            planUpdateFields.commit_ends_at = addMonths(new Date(Date.now()), 6).toISOString();
          } else {
            planUpdateFields.commit_ends_at = null;
          }
          await database
            .update(kiloclaw_subscriptions)
            .set(planUpdateFields)
            .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
          summary.plan_switches++;
        }
      }

      // Compute cost based on (possibly switched) plan
      const cost = planCostMicrodollars(effectivePlan);

      // These fields are guaranteed non-null by the sweep query filter
      if (!row.credit_renewal_at || !row.current_period_end) continue;

      // Compute effective balance
      const currentBalance = (row.total_microdollars_acquired ?? 0) - (row.microdollars_used ?? 0);
      const projectedBonus = await getProjectedKiloPassBonus(row.user_id, cost);
      const effectiveBalance = currentBalance + projectedBonus;

      if (effectiveBalance >= cost) {
        // ── SUFFICIENT BALANCE: deduct and advance ──

        // Idempotency key from credit_renewal_at
        const renewalDate = new Date(row.credit_renewal_at);
        const creditCategory = buildCreditCategory(effectivePlan, renewalDate);

        // Compute new period (advance by one billing period)
        const months = periodLengthMonths(effectivePlan);
        const newPeriodStart = row.current_period_end;
        const newPeriodEnd = addMonths(new Date(newPeriodStart), months).toISOString();
        const newCreditRenewalAt = newPeriodEnd;

        const wasPastDue = row.status === 'past_due';
        const wasSuspended = !!row.suspended_at;

        // Transaction — deduction + period advance
        let deductionSucceeded = false;
        await database.transaction(async (tx: DrizzleTransaction) => {
          const insertResult = await tx
            .insert(credit_transactions)
            .values({
              kilo_user_id: row.user_id,
              amount_microdollars: -cost,
              is_free: false,
              description: `KiloClaw ${effectivePlan} subscription renewal`,
              credit_category: creditCategory,
              check_category_uniqueness: true,
            })
            .onConflictDoNothing();

          // Duplicate key → skip (idempotent)
          if (insertResult.rowCount === 0) return;

          deductionSucceeded = true;

          // Decrement balance
          await tx
            .update(kilocode_users)
            .set({
              total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${cost}`,
            })
            .where(eq(kilocode_users.id, row.user_id));

          // Build subscription update
          const updateSet: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
            current_period_start: newPeriodStart,
            current_period_end: newPeriodEnd,
            credit_renewal_at: newCreditRenewalAt,
            auto_top_up_triggered_for_period: null,
          };

          // Clear past_due on recovery
          if (wasPastDue) {
            updateSet.status = 'active';
            updateSet.past_due_since = null;
          }

          // Extend commit_ends_at if past
          if (effectivePlan === 'commit' && row.commit_ends_at) {
            const commitEnd = new Date(row.commit_ends_at);
            if (commitEnd.getTime() <= Date.now()) {
              updateSet.commit_ends_at = addMonths(commitEnd, 6).toISOString();
            }
          }

          await tx
            .update(kiloclaw_subscriptions)
            .set(updateSet)
            .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
        });

        if (!deductionSucceeded) continue; // Duplicate, no-op

        summary.renewals++;

        // Post-commit: Kilo Pass bonus evaluation
        try {
          await evaluateKiloPassBonusAfterDeduction(row.user_id, cost);
        } catch (error) {
          logError('Kilo Pass bonus evaluation failed after renewal', {
            user_id: row.user_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Grace-period recovery (past_due, not suspended) — delete email log
        if (wasPastDue && !wasSuspended) {
          await database
            .delete(kiloclaw_email_log)
            .where(
              and(
                eq(kiloclaw_email_log.user_id, row.user_id),
                eq(kiloclaw_email_log.email_type, 'claw_credit_renewal_failed')
              )
            );
          summary.recoveries++;
        }

        // Suspended recovery — auto-resume
        if (wasPastDue && wasSuspended) {
          await autoResumeIfSuspended(row.user_id);
          summary.auto_resumes++;
          summary.recoveries++;
        }
      } else {
        // ── INSUFFICIENT BALANCE ──

        // Check auto top-up eligibility
        const hasAutoTopUp = !!row.auto_top_up_enabled;
        const alreadyTriggered = !!row.auto_top_up_triggered_for_period;

        if (hasAutoTopUp && !alreadyTriggered) {
          // Fire-and-skip: persist marker BEFORE triggering
          await database
            .update(kiloclaw_subscriptions)
            .set({ auto_top_up_triggered_for_period: row.credit_renewal_at })
            .where(eq(kiloclaw_subscriptions.user_id, row.user_id));

          try {
            await triggerAutoTopUpForKiloClaw(row.user_id, row.credit_renewal_at);
          } catch (error) {
            logError('Auto top-up trigger failed', {
              user_id: row.user_id,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          summary.auto_top_up_triggered++;
          continue; // Skip — next sweep re-evaluates
        }

        // Set past_due (preserve existing past_due_since)
        await database
          .update(kiloclaw_subscriptions)
          .set({
            status: 'past_due',
            past_due_since: sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, ${new Date(Date.now()).toISOString()})`,
          })
          .where(eq(kiloclaw_subscriptions.user_id, row.user_id));
        summary.past_due++;

        // Send credit-renewal-failed notification (idempotent)
        try {
          await trySendEmail(
            database,
            row.user_id,
            row.email,
            'claw_credit_renewal_failed',
            'clawCreditRenewalFailed',
            { claw_url: clawUrl }
          );
        } catch (error) {
          captureException(error);
          logError('Failed to send credit renewal failed email', {
            user_id: row.user_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Credit renewal sweep failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('Credit renewal sweep completed', { summary });
  return summary;
}
