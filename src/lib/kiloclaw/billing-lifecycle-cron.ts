import 'server-only';

import { and, eq, lt, lte, gte, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { addMonths, format } from 'date-fns';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '@kilocode/db/schema';
import {
  credit_transactions,
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
  kiloclaw_earlybird_purchases,
  kilocode_users,
} from '@kilocode/db/schema';
import type {
  KiloClawPlan,
  KiloClawSubscriptionStatus,
  KiloClawScheduledPlan,
} from '@kilocode/db/schema-types';
import type { TemplateName } from '@/lib/email';
import { send as sendEmail } from '@/lib/email';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { workerInstanceId } from '@/lib/kiloclaw/instance-registry';
import { autoResumeIfSuspended, ensureAutoIntroSchedule } from '@/lib/kiloclaw/stripe-handlers';
import {
  KILOCLAW_PLAN_COST_MICRODOLLARS,
  projectPendingKiloPassBonusMicrodollars,
} from '@/lib/kiloclaw/credit-billing';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import { isIntroPriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import { client as stripe } from '@/lib/stripe-client';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import { NEXTAUTH_URL, KILOCLAW_BILLING_ENFORCEMENT } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('kiloclaw-billing-cron', 'info');
const logWarning = sentryLogger('kiloclaw-billing-cron', 'warning');
const logError = sentryLogger('kiloclaw-billing-cron', 'error');

const MS_PER_DAY = 86_400_000;
const DESTRUCTION_GRACE_DAYS = 7;
const PAST_DUE_THRESHOLD_DAYS = 14;
const TRIAL_WARNING_DAYS = 2;
const DESTRUCTION_WARNING_DAYS = 2;

/** Format a Date for human-readable email display, e.g. "March 15, 2026". */
function formatDateForEmail(d: Date): string {
  return format(d, 'MMMM d, yyyy');
}

type CronSummary = {
  credit_renewals: number;
  credit_renewals_canceled: number;
  credit_renewals_past_due: number;
  credit_renewals_auto_top_up: number;
  credit_renewals_skipped_duplicate: number;
  interrupted_auto_resumes: number;
  trial_warnings: number;
  earlybird_warnings: number;
  sweep1_trial_expiry: number;
  sweep2_subscription_expiry: number;
  destruction_warnings: number;
  sweep3_instance_destruction: number;
  sweep4_past_due_cleanup: number;
  sweep5_intro_schedules_repaired: number;
  emails_sent: number;
  emails_skipped: number;
  errors: number;
};

/**
 * Idempotent email send: inserts into kiloclaw_email_log with onConflictDoNothing.
 * If rowCount === 0, the email was already sent for this user+type — skip.
 */
async function trySendEmail(
  database: PostgresJsDatabase<typeof schema>,
  userId: string,
  userEmail: string,
  emailType: string,
  templateName: TemplateName,
  templateVars: Record<string, string>,
  summary: CronSummary,
  subjectOverride?: string
): Promise<boolean> {
  // Insert first to claim the slot; if rowCount is 0, already sent — skip.
  // If send fails, delete to allow retry on the next cron run.
  const result = await database
    .insert(kiloclaw_email_log)
    .values({ user_id: userId, email_type: emailType })
    .onConflictDoNothing();
  if (result.rowCount === 0) {
    summary.emails_skipped++;
    return false;
  }
  try {
    const emailResult = await sendEmail({
      to: userEmail,
      templateName,
      templateVars,
      subjectOverride,
    });

    if (!emailResult.sent) {
      if (emailResult.reason === 'provider_not_configured') {
        // Transient — credentials may be added later; remove idempotency guard so the next cron run can retry
        await database
          .delete(kiloclaw_email_log)
          .where(
            and(
              eq(kiloclaw_email_log.user_id, userId),
              eq(kiloclaw_email_log.email_type, emailType)
            )
          );
      }
      // For neverbounce_rejected the address is permanently invalid — keep the
      // idempotency row so we don't re-verify on every sweep.
      summary.emails_skipped++;
      return false;
    }
  } catch (error) {
    try {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(eq(kiloclaw_email_log.user_id, userId), eq(kiloclaw_email_log.email_type, emailType))
        );
    } catch (deleteError) {
      logWarning('Failed to remove email log row after send failure — email may not retry', {
        user_id: userId,
        emailType,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }
    throw error;
  }
  summary.emails_sent++;
  return true;
}

type CreditRenewalRow = {
  user_id: string;
  email: string;
  instance_id: string | null;
  plan: KiloClawPlan;
  status: KiloClawSubscriptionStatus;
  credit_renewal_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  scheduled_plan: KiloClawScheduledPlan | null;
  commit_ends_at: string | null;
  past_due_since: string | null;
  suspended_at: string | null;
  auto_top_up_triggered_for_period: string | null;
  total_microdollars_acquired: number;
  microdollars_used: number;
  auto_top_up_enabled: boolean;
  kilo_pass_threshold: number | null;
  next_credit_expiration_at: string | null;
  user_updated_at: string;
};

/**
 * Process a single pure-credit subscription renewal.
 * Implements Credit Renewal rules 2-15.
 */
async function processCreditRenewalRow(
  database: PostgresJsDatabase<typeof schema>,
  row: CreditRenewalRow,
  clawUrl: string,
  summary: CronSummary
): Promise<void> {
  const { user_id: userId, credit_renewal_at: renewalAt } = row;
  if (!renewalAt) return;

  // Scope all subscription mutations to the specific instance row when available.
  // Legacy rows without instance_id fall back to user-scoped matching.
  const subscriptionWhere = row.instance_id
    ? and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_subscriptions.instance_id, row.instance_id)
      )
    : eq(kiloclaw_subscriptions.user_id, userId);

  // Rule 5: Cancel-at-period-end — skip deduction, set status to canceled.
  if (row.cancel_at_period_end) {
    await database
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        auto_top_up_triggered_for_period: null,
      })
      .where(subscriptionWhere);
    summary.credit_renewals_canceled++;
    logInfo('Credit renewal: canceled at period end', { user_id: userId });
    return;
  }

  // Rule 15: Determine effective plan (apply scheduled plan switch at period boundary).
  const effectivePlan =
    row.scheduled_plan === 'commit' || row.scheduled_plan === 'standard'
      ? row.scheduled_plan
      : row.plan;
  if (effectivePlan !== 'commit' && effectivePlan !== 'standard') {
    logError('Credit renewal: unexpected plan', { user_id: userId, plan: effectivePlan });
    return;
  }
  const applyingPlanSwitch = row.scheduled_plan !== null && row.scheduled_plan !== row.plan;
  const costMicrodollars = KILOCLAW_PLAN_COST_MICRODOLLARS[effectivePlan];
  const periodMonths = effectivePlan === 'commit' ? 6 : 1;

  // Compute effective balance (Credit Enrollment rule 3, referenced by Credit Renewal rule 6).
  // The deduction increments microdollars_used, so project the post-deduction
  // value to correctly evaluate whether the spend crosses the bonus threshold.
  const rawBalance = row.total_microdollars_acquired - row.microdollars_used;
  const projectedBonus = await projectPendingKiloPassBonusMicrodollars({
    userId,
    microdollarsUsed: row.microdollars_used + costMicrodollars,
    kiloPassThreshold: row.kilo_pass_threshold,
  });
  const effectiveBalance = rawBalance + projectedBonus;

  if (effectiveBalance >= costMicrodollars) {
    // ── Sufficient balance: deduct and advance ──
    // Rule 2: Idempotency key derived from credit_renewal_at, not wall clock.
    const periodKey = format(new Date(renewalAt), 'yyyy-MM');
    const instanceId = row.instance_id ?? 'unknown';
    const categoryPrefix =
      effectivePlan === 'commit'
        ? `kiloclaw-subscription-commit:${instanceId}`
        : `kiloclaw-subscription:${instanceId}`;
    const deductionCategory = `${categoryPrefix}:${periodKey}`;

    // Rule 3: Single transaction for deduction + period advancement.
    const newPeriodStart = renewalAt;
    const newPeriodEnd = addMonths(new Date(renewalAt), periodMonths).toISOString();
    const wasPastDue = row.status === 'past_due';
    let deductionIsNew = false;

    await database.transaction(async tx => {
      // Rule 2: Insert deduction with conflict-safe uniqueness.
      const deductionResult = await tx
        .insert(credit_transactions)
        .values({
          id: crypto.randomUUID(),
          kilo_user_id: userId,
          amount_microdollars: -costMicrodollars,
          is_free: false,
          description: `KiloClaw ${effectivePlan} renewal`,
          credit_category: deductionCategory,
          check_category_uniqueness: true,
          original_baseline_microdollars_used: row.microdollars_used,
        })
        .onConflictDoNothing();

      deductionIsNew = (deductionResult.rowCount ?? 0) > 0;

      if (!deductionIsNew) {
        // Rule 4: Duplicate key from prior committed transaction — skip.
        return;
      }

      // Atomically increment microdollars_used so the deduction counts as
      // spend toward the Kilo Pass bonus unlock threshold.
      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));

      // Build subscription update set.
      const updateSet: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
        current_period_start: newPeriodStart,
        current_period_end: newPeriodEnd,
        credit_renewal_at: newPeriodEnd,
        auto_top_up_triggered_for_period: null,
      };

      // Rule 15: Apply plan switch inside the transaction.
      if (applyingPlanSwitch) {
        updateSet.plan = effectivePlan;
        updateSet.scheduled_plan = null;
        updateSet.scheduled_by = null;
        if (effectivePlan === 'commit') {
          updateSet.commit_ends_at = addMonths(new Date(newPeriodStart), 6).toISOString();
        } else {
          updateSet.commit_ends_at = null;
        }
      }

      // Rule 7: Commit plan auto-renewal — extend commit boundary when reached.
      if (
        effectivePlan === 'commit' &&
        !applyingPlanSwitch &&
        row.commit_ends_at &&
        new Date(row.commit_ends_at) <= new Date(newPeriodStart)
      ) {
        updateSet.commit_ends_at = addMonths(new Date(row.commit_ends_at), 6).toISOString();
      }

      // Rule 8: Clear past-due state on successful deduction.
      if (wasPastDue) {
        updateSet.status = 'active';
        updateSet.past_due_since = null;
      }

      await tx.update(kiloclaw_subscriptions).set(updateSet).where(subscriptionWhere);
    });

    if (!deductionIsNew) {
      summary.credit_renewals_skipped_duplicate++;
      logInfo('Credit renewal: skipped duplicate deduction', {
        user_id: userId,
        deductionCategory,
      });
      return;
    }

    // Post-transaction side effects.

    // Rule 6: Bonus credit evaluation (best-effort).
    try {
      await maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: userId,
        nowIso: new Date().toISOString(),
      });
    } catch (error) {
      logError('Kilo Pass bonus evaluation failed after credit renewal', {
        user_id: userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Rule 9: Grace-period recovery — delete credit-renewal-failed email.
    if (wasPastDue && !row.suspended_at) {
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, userId),
            eq(kiloclaw_email_log.email_type, 'claw_credit_renewal_failed')
          )
        );
    }

    // Rule 10: Suspended recovery — auto-resume instance.
    if (wasPastDue && row.suspended_at) {
      await autoResumeIfSuspended(userId, row.instance_id ?? undefined);
    }

    summary.credit_renewals++;
    logInfo('Credit renewal: deduction succeeded', {
      user_id: userId,
      plan: effectivePlan,
      costMicrodollars,
      newPeriodEnd,
      ...(applyingPlanSwitch ? { planSwitch: `${row.plan} → ${effectivePlan}` } : {}),
    });
  } else {
    // ── Insufficient balance ──

    // Rule 11: Check auto top-up before going past-due.
    if (row.auto_top_up_enabled && !row.auto_top_up_triggered_for_period) {
      // Persist marker BEFORE triggering (crash safety per spec rule 11).
      await database
        .update(kiloclaw_subscriptions)
        .set({ auto_top_up_triggered_for_period: renewalAt })
        .where(subscriptionWhere);

      // Fire-and-skip: trigger auto top-up, then skip row.
      // maybePerformAutoTopUp handles lock acquisition, invoice creation,
      // and payment asynchronously via webhook.
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
        logError('Auto top-up trigger failed during credit renewal', {
          user_id: userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      summary.credit_renewals_auto_top_up++;
      logInfo('Credit renewal: auto top-up triggered, skipping row', { user_id: userId });
      return;
    }

    // Rule 12: Set past-due status.
    await database
      .update(kiloclaw_subscriptions)
      .set({
        status: 'past_due',
        past_due_since: sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, now())`,
      })
      .where(subscriptionWhere);

    // Rule 13: Send credit-renewal-failed notification.
    await trySendEmail(
      database,
      userId,
      row.email,
      'claw_credit_renewal_failed',
      'clawCreditRenewalFailed',
      { claw_url: clawUrl },
      summary
    );

    summary.credit_renewals_past_due++;
    logInfo('Credit renewal: insufficient balance, set past-due', {
      user_id: userId,
      effectiveBalance,
      costMicrodollars,
    });
  }
}

export async function runKiloClawBillingLifecycleCron(
  database: PostgresJsDatabase<typeof schema>
): Promise<CronSummary> {
  const summary: CronSummary = {
    credit_renewals: 0,
    credit_renewals_canceled: 0,
    credit_renewals_past_due: 0,
    credit_renewals_auto_top_up: 0,
    credit_renewals_skipped_duplicate: 0,
    interrupted_auto_resumes: 0,
    trial_warnings: 0,
    earlybird_warnings: 0,
    sweep1_trial_expiry: 0,
    sweep2_subscription_expiry: 0,
    destruction_warnings: 0,
    sweep3_instance_destruction: 0,
    sweep4_past_due_cleanup: 0,
    sweep5_intro_schedules_repaired: 0,
    emails_sent: 0,
    emails_skipped: 0,
    errors: 0,
  };

  if (!KILOCLAW_BILLING_ENFORCEMENT) {
    logInfo('KiloClaw billing enforcement is disabled, skipping lifecycle cron');
    return summary;
  }

  const now = new Date().toISOString();
  const client = new KiloClawInternalClient();
  const clawUrl = `${NEXTAUTH_URL}/claw`;

  // ── Credit Renewal Sweep ────────────────────────────────────────────
  // Runs before all other sweeps (spec Billing Lifecycle Background Job rule 4).
  // Selects pure credit subscriptions where renewal is due. Hybrid rows
  // are excluded — their renewal is owned by invoice settlement.
  const creditRenewalRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      instance_id: kiloclaw_subscriptions.instance_id,
      plan: kiloclaw_subscriptions.plan,
      status: kiloclaw_subscriptions.status,
      credit_renewal_at: kiloclaw_subscriptions.credit_renewal_at,
      current_period_end: kiloclaw_subscriptions.current_period_end,
      cancel_at_period_end: kiloclaw_subscriptions.cancel_at_period_end,
      scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
      commit_ends_at: kiloclaw_subscriptions.commit_ends_at,
      past_due_since: kiloclaw_subscriptions.past_due_since,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      auto_top_up_triggered_for_period: kiloclaw_subscriptions.auto_top_up_triggered_for_period,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      auto_top_up_enabled: kilocode_users.auto_top_up_enabled,
      kilo_pass_threshold: kilocode_users.kilo_pass_threshold,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      user_updated_at: kilocode_users.updated_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.payment_source, 'credits'),
        isNull(kiloclaw_subscriptions.stripe_subscription_id),
        inArray(kiloclaw_subscriptions.status, ['active', 'past_due']),
        lte(kiloclaw_subscriptions.credit_renewal_at, now)
      )
    );

  for (const row of creditRenewalRows) {
    try {
      await processCreditRenewalRow(database, row, clawUrl, summary);
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Credit renewal sweep failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Interrupted Auto-Resume Retry ───────────────────────────────────
  // Detects credit-funded subscriptions (hybrid + pure) in active status
  // with a non-null suspension timestamp — indicates auto-resume was
  // interrupted after payment recovery (spec rule 5).
  const interruptedResumeRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.payment_source, 'credits'),
        eq(kiloclaw_subscriptions.status, 'active'),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of interruptedResumeRows) {
    try {
      await autoResumeIfSuspended(row.user_id, row.instance_id ?? undefined);
      summary.interrupted_auto_resumes++;
      logInfo('Retried interrupted auto-resume', { user_id: row.user_id });
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Interrupted auto-resume retry failed', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 0a: Trial ending-soon warning ─────────────────────────────
  const trialWarningCutoff = new Date(Date.now() + TRIAL_WARNING_DAYS * MS_PER_DAY).toISOString();
  const trialWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        gte(kiloclaw_subscriptions.trial_ends_at, now),
        lte(kiloclaw_subscriptions.trial_ends_at, trialWarningCutoff),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of trialWarningRows) {
    try {
      if (!row.trial_ends_at) continue;
      const daysRemaining = Math.ceil(
        (new Date(row.trial_ends_at).getTime() - Date.now()) / MS_PER_DAY
      );

      if (daysRemaining <= 1) {
        // 1-day warning — more urgent, replaces the ending-soon message
        const sent = await trySendEmail(
          database,
          row.user_id,
          row.email,
          'claw_trial_1d',
          'clawTrialExpiresTomorrow',
          { claw_url: clawUrl },
          summary
        );
        if (sent) summary.trial_warnings++;
      } else {
        // Ending-soon warning (idempotent — skipped if already sent).
        // Key kept as 'claw_trial_5d' so users warned under the old 5-day
        // threshold aren't re-notified after the threshold changed to 2 days.
        const sent = await trySendEmail(
          database,
          row.user_id,
          row.email,
          'claw_trial_5d',
          'clawTrialEndingSoon',
          { days_remaining: String(daysRemaining), claw_url: clawUrl },
          summary,
          `Your KiloClaw Trial Ends in ${daysRemaining} Days`
        );
        if (sent) summary.trial_warnings++;
      }
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 0a (trial warning) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 0b: Earlybird Warnings ───────────────────────────────────
  const earlybirdExpiry = new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE);
  const daysUntilEarlybird = Math.ceil((earlybirdExpiry.getTime() - Date.now()) / MS_PER_DAY);

  if (daysUntilEarlybird > 0 && daysUntilEarlybird <= 14) {
    const earlybirdRows = await database
      .select({
        user_id: kiloclaw_earlybird_purchases.user_id,
        email: kilocode_users.google_user_email,
      })
      .from(kiloclaw_earlybird_purchases)
      .innerJoin(kilocode_users, eq(kiloclaw_earlybird_purchases.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_earlybird_purchases.user_id, kiloclaw_subscriptions.user_id)
      )
      .where(
        and(
          sql`(${kiloclaw_subscriptions.status} IS NULL OR ${kiloclaw_subscriptions.status} NOT IN ('active', 'trialing'))`,
          isNull(kiloclaw_subscriptions.suspended_at)
        )
      );

    for (const row of earlybirdRows) {
      try {
        const expiryDate = formatDateForEmail(earlybirdExpiry);

        if (daysUntilEarlybird <= 1) {
          // 1-day warning — more urgent, replaces the 14-day message
          const sent = await trySendEmail(
            database,
            row.user_id,
            row.email,
            'claw_earlybird_1d',
            'clawEarlybirdExpiresTomorrow',
            { expiry_date: expiryDate, claw_url: clawUrl },
            summary
          );
          if (sent) summary.earlybird_warnings++;
        } else {
          // 14-day warning (idempotent — skipped if already sent)
          const sent = await trySendEmail(
            database,
            row.user_id,
            row.email,
            'claw_earlybird_14d',
            'clawEarlybirdEndingSoon',
            {
              days_remaining: String(daysUntilEarlybird),
              expiry_date: expiryDate,
              claw_url: clawUrl,
            },
            summary
          );
          if (sent) summary.earlybird_warnings++;
        }
      } catch (error) {
        summary.errors++;
        captureException(error);
        logError('Sweep 0b (earlybird warning) failed for user', {
          user_id: row.user_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ── Sweep 1: Trial Expiry ──────────────────────────────────────────
  const expiredTrials = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'trialing'),
        lt(kiloclaw_subscriptions.trial_ends_at, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredTrials) {
    try {
      // Per spec: stop/destroy failures MUST be logged and the state
      // transition MUST proceed regardless, so transient outages don't
      // leave expired accounts active.
      // Only stop if this subscription row owns an instance; a stale row
      // with instance_id=null has nothing to stop.
      if (row.instance_id)
        try {
          await client.stop(
            row.user_id,
            workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id ?? undefined })
          );
        } catch (stopError) {
          const isExpected =
            stopError instanceof KiloClawApiError &&
            (stopError.statusCode === 404 || stopError.statusCode === 409);
          if (isExpected) {
            logInfo('Sweep 1: stop() returned expected error, proceeding with state transition', {
              user_id: row.user_id,
              statusCode: stopError.statusCode,
              error: stopError.message,
            });
          } else {
            captureException(stopError);
            logError('Sweep 1: stop() failed, proceeding with state transition', {
              user_id: row.user_id,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          }
        }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          status: 'canceled',
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));
      summary.sweep1_trial_expiry++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_trial',
        'clawSuspendedTrial',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 1 (trial expiry) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 2: Subscription Period Expiry ────────────────────────────
  const expiredSubscriptions = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'canceled'),
        lt(kiloclaw_subscriptions.current_period_end, now),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of expiredSubscriptions) {
    try {
      if (row.instance_id)
        try {
          await client.stop(
            row.user_id,
            workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id ?? undefined })
          );
        } catch (stopError) {
          const isExpected =
            stopError instanceof KiloClawApiError &&
            (stopError.statusCode === 404 || stopError.statusCode === 409);
          if (isExpected) {
            logInfo('Sweep 2: stop() returned expected error, proceeding with state transition', {
              user_id: row.user_id,
              statusCode: stopError.statusCode,
              error: stopError.message,
            });
          } else {
            captureException(stopError);
            logError('Sweep 2: stop() failed, proceeding with state transition', {
              user_id: row.user_id,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          }
        }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));
      summary.sweep2_subscription_expiry++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_subscription',
        'clawSuspendedSubscription',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 2 (subscription expiry) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 2.5: Destruction 2-day Warning ───────────────────────────
  const twoDaysFromNow = new Date(Date.now() + DESTRUCTION_WARNING_DAYS * MS_PER_DAY).toISOString();
  const destructionWarningRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      email: kilocode_users.google_user_email,
      destruction_deadline: kiloclaw_subscriptions.destruction_deadline,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .where(
      and(
        gte(kiloclaw_subscriptions.destruction_deadline, now),
        lte(kiloclaw_subscriptions.destruction_deadline, twoDaysFromNow),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionWarningRows) {
    try {
      if (!row.destruction_deadline) continue;
      const sent = await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_destruction_warning',
        'clawDestructionWarning',
        {
          destruction_date: formatDateForEmail(new Date(row.destruction_deadline)),
          claw_url: clawUrl,
        },
        summary
      );
      if (sent) summary.destruction_warnings++;
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 2.5 (destruction warning) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 3: Instance Destruction ──────────────────────────────────
  const destructionCandidates = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        lt(kiloclaw_subscriptions.destruction_deadline, now),
        isNotNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of destructionCandidates) {
    try {
      if (row.instance_id)
        try {
          await client.destroy(
            row.user_id,
            workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id ?? undefined })
          );
        } catch (destroyError) {
          const isExpected =
            destroyError instanceof KiloClawApiError &&
            (destroyError.statusCode === 404 || destroyError.statusCode === 409);
          if (isExpected) {
            logInfo(
              'Sweep 3: destroy() returned expected error, proceeding with state transition',
              {
                user_id: row.user_id,
                statusCode: destroyError.statusCode,
                error: destroyError.message,
              }
            );
          } else {
            captureException(destroyError);
            logError('Sweep 3: destroy() failed, proceeding with state transition', {
              user_id: row.user_id,
              error: destroyError instanceof Error ? destroyError.message : String(destroyError),
            });
          }
        }
      // Mark the specific instance as destroyed
      if (row.instance_id) {
        await database
          .update(kiloclaw_instances)
          .set({ destroyed_at: now })
          .where(
            and(eq(kiloclaw_instances.id, row.instance_id), isNull(kiloclaw_instances.destroyed_at))
          );
      }
      await database
        .update(kiloclaw_subscriptions)
        .set({ destruction_deadline: null })
        .where(eq(kiloclaw_subscriptions.id, row.id));
      summary.sweep3_instance_destruction++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_instance_destroyed',
        'clawInstanceDestroyed',
        { claw_url: clawUrl },
        summary
      );

      // Clear instance-ready email log so a future re-provision can trigger it again.
      // The email_type is scoped per-instance (claw_instance_ready:{sandboxId}),
      // so we use a prefix match to clear all variants for this user.
      await database
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, row.user_id),
            sql`${kiloclaw_email_log.email_type} LIKE 'claw_instance_ready:%'`
          )
        );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 3 (instance destruction) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 4: Past-Due Cleanup ──────────────────────────────────────
  const fourteenDaysAgo = new Date(Date.now() - PAST_DUE_THRESHOLD_DAYS * MS_PER_DAY).toISOString();
  const pastDueRows = await database
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      email: kilocode_users.google_user_email,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kilocode_users, eq(kiloclaw_subscriptions.user_id, kilocode_users.id))
    .leftJoin(kiloclaw_instances, eq(kiloclaw_subscriptions.instance_id, kiloclaw_instances.id))
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'past_due'),
        lt(kiloclaw_subscriptions.past_due_since, fourteenDaysAgo),
        isNull(kiloclaw_subscriptions.suspended_at)
      )
    );

  for (const row of pastDueRows) {
    try {
      if (row.instance_id)
        try {
          await client.stop(
            row.user_id,
            workerInstanceId({ id: row.instance_id, sandbox_id: row.sandbox_id ?? undefined })
          );
        } catch (stopError) {
          const isExpected =
            stopError instanceof KiloClawApiError &&
            (stopError.statusCode === 404 || stopError.statusCode === 409);
          if (isExpected) {
            logInfo('Sweep 4: stop() returned expected error, proceeding with state transition', {
              user_id: row.user_id,
              statusCode: stopError.statusCode,
              error: stopError.message,
            });
          } else {
            captureException(stopError);
            logError('Sweep 4: stop() failed, proceeding with state transition', {
              user_id: row.user_id,
              error: stopError instanceof Error ? stopError.message : String(stopError),
            });
          }
        }
      const destructionDeadline = new Date(Date.now() + DESTRUCTION_GRACE_DAYS * MS_PER_DAY);
      await database
        .update(kiloclaw_subscriptions)
        .set({
          suspended_at: now,
          destruction_deadline: destructionDeadline.toISOString(),
        })
        .where(eq(kiloclaw_subscriptions.id, row.id));
      summary.sweep4_past_due_cleanup++;

      await trySendEmail(
        database,
        row.user_id,
        row.email,
        'claw_suspended_payment',
        'clawSuspendedPayment',
        {
          destruction_date: formatDateForEmail(destructionDeadline),
          claw_url: clawUrl,
        },
        summary
      );
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 4 (past-due cleanup) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Sweep 5: Repair stranded intro-price subscriptions ─────────────
  const strandedIntroRows = await database
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.status, 'active'),
        isNull(kiloclaw_subscriptions.stripe_schedule_id),
        isNotNull(kiloclaw_subscriptions.stripe_subscription_id),
        eq(kiloclaw_subscriptions.cancel_at_period_end, false)
      )
    );

  for (const row of strandedIntroRows) {
    try {
      const stripeSubId = row.stripe_subscription_id;
      if (!stripeSubId) continue;
      const liveSub = await stripe.subscriptions.retrieve(stripeSubId);
      const priceId = liveSub.items.data[0]?.price?.id;
      if (!priceId || !isIntroPriceId(priceId)) continue;
      if (liveSub.schedule) continue;

      await ensureAutoIntroSchedule(stripeSubId, row.user_id);
      summary.sweep5_intro_schedules_repaired++;
      logInfo('Sweep 5: repaired stranded intro-price subscription', {
        user_id: row.user_id,
        stripe_subscription_id: row.stripe_subscription_id,
      });
    } catch (error) {
      summary.errors++;
      captureException(error);
      logError('Sweep 5 (intro schedule repair) failed for user', {
        user_id: row.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logInfo('KiloClaw billing lifecycle cron completed', { summary });
  return summary;
}
