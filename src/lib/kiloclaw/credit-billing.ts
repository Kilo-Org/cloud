import 'server-only';

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { addMonths, format } from 'date-fns';

import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  kilocode_users,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { processTopUp } from '@/lib/credits';
import { autoResumeIfSuspended } from '@/lib/kiloclaw/instance-lifecycle';
import {
  computeUsageTriggeredMonthlyBonusDecision,
  maybeIssueKiloPassBonusFromUsageThreshold,
} from '@/lib/kilo-pass/usage-triggered-bonus';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { getEffectiveKiloPassThreshold } from '@/lib/kilo-pass/threshold';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import {
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@/lib/kilo-pass/constants';
import { computeIssueMonth } from '@/lib/kilo-pass/issuance';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import { sentryLogger } from '@/lib/utils.server';

const logInfo = sentryLogger('kiloclaw-credit-billing', 'info');
const logWarning = sentryLogger('kiloclaw-credit-billing', 'warning');
const logError = sentryLogger('kiloclaw-credit-billing', 'error');

export const KILOCLAW_PLAN_COST_MICRODOLLARS = {
  standard: 9_000_000, // $9/month
  commit: 48_000_000, // $48/6 months
} as const;

// First-month discount for new standard-plan credit enrollments (matches
// the Stripe-configured intro price). See spec Credit Enrollment rule 3.
export const KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS = 4_000_000; // $4

/**
 * Project the pending Kilo Pass bonus microdollars that would be awarded
 * by the next call to maybeIssueKiloPassBonusFromUsageThreshold.
 *
 * Returns 0 when the user has no Kilo Pass, usage hasn't crossed the
 * threshold, or the subscription isn't active. This is a read-only
 * projection — no credits are issued.
 */
export async function projectPendingKiloPassBonusMicrodollars(params: {
  userId: string;
  microdollarsUsed: number;
  kiloPassThreshold: number | null;
}): Promise<number> {
  const { userId, microdollarsUsed, kiloPassThreshold } = params;

  const effectiveThreshold = getEffectiveKiloPassThreshold(kiloPassThreshold);
  if (effectiveThreshold === null || microdollarsUsed < effectiveThreshold) return 0;

  const subscription = await getKiloPassStateForUser(db, userId);
  if (!subscription || subscription.status !== 'active') return 0;

  const tierConfig = KILO_PASS_TIER_CONFIG[subscription.tier];
  const monthlyBaseAmountUsd = tierConfig.monthlyPriceUsd;

  let bonusPercent: number;
  if (subscription.cadence !== KiloPassCadence.Monthly) {
    bonusPercent = KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT;
  } else {
    const issueMonth = computeIssueMonth(dayjs().utc());
    // Conservatively assume returning subscriber to avoid over-projecting
    // the 50% first-time promo. Under-projection is safe: the user still
    // succeeds via the post-deduction bonus evaluation (spec rule 6).
    const assumeReturningSubscriber = false;
    const decision = computeUsageTriggeredMonthlyBonusDecision({
      tier: subscription.tier,
      startedAtIso: subscription.startedAt,
      currentStreakMonths: subscription.currentStreakMonths,
      isFirstTimeSubscriberEver: assumeReturningSubscriber,
      issueMonth,
    });
    bonusPercent = decision.bonusPercentApplied;
  }

  return Math.round(monthlyBaseAmountUsd * bonusPercent * 1_000_000);
}

/**
 * Settle a Stripe-funded KiloClaw invoice into the credit ledger.
 *
 * Creates a balance-neutral credit pair (positive deposit + matching negative deduction),
 * converts the subscription to hybrid state (payment_source='credits' with
 * stripe_subscription_id preserved), and advances the billing period from
 * invoice-derived boundaries.
 */
export async function applyStripeFundedKiloClawPeriod(params: {
  userId: string;
  stripeSubscriptionId: string;
  chargeId: string;
  plan: 'commit' | 'standard';
  amountMicrodollars: number;
  periodStart: string;
  periodEnd: string;
}): Promise<void> {
  const {
    userId,
    stripeSubscriptionId,
    chargeId,
    plan,
    amountMicrodollars,
    periodStart,
    periodEnd,
  } = params;

  const amountCents = Math.round(amountMicrodollars / 10_000);
  const periodStartDate = periodStart.slice(0, 10); // YYYY-MM-DD

  let wasSuspended = false;
  let resolvedInstanceId: string | undefined;

  await db.transaction(async tx => {
    // Fetch the user row — processTopUp needs the full User record.
    const user = await tx.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, userId),
    });

    if (!user) {
      logWarning('User not found for credit settlement', { user_id: userId, chargeId });
      return;
    }

    // Step 1a: Create the positive credit deposit via processTopUp.
    // processTopUp uses stripe_payment_id uniqueness for idempotency.
    const deposited = await processTopUp(
      user,
      amountCents,
      { type: 'stripe', stripe_payment_id: chargeId },
      {
        skipPostTopUpFreeStuff: true,
        dbOrTx: tx,
        creditDescription: `KiloClaw ${plan} settlement`,
      }
    );

    if (!deposited) {
      // Duplicate charge — already processed. Return early (idempotent).
      logInfo('Duplicate charge skipped', { user_id: userId, chargeId });
      return;
    }

    // Step 1b: Insert the matching negative credit deduction.
    const deductionCategory = `kiloclaw-settlement:${stripeSubscriptionId}:${periodStartDate}`;

    const deductionResult = await tx
      .insert(credit_transactions)
      .values({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        amount_microdollars: -amountMicrodollars,
        is_free: false,
        description: `KiloClaw ${plan} period deduction`,
        credit_category: deductionCategory,
        check_category_uniqueness: true,
        original_baseline_microdollars_used: user.microdollars_used,
      })
      .onConflictDoNothing();

    const deductionIsNew = (deductionResult.rowCount ?? 0) > 0;

    if (deductionIsNew) {
      // Step 1c: Decrement total_microdollars_acquired to make the operation balance-neutral.
      // processTopUp already incremented by amountMicrodollars; this reverses it.
      // Only decrement on new deductions — a duplicate deduction means the prior
      // transaction already decremented.
      await tx
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${amountMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));
    } else {
      logInfo('Duplicate deduction skipped, proceeding with subscription update', {
        user_id: userId,
        deductionCategory,
      });
    }

    // Step 1d: Read existing subscription row to check for suspension and scheduled plan.
    // Key on stripe_subscription_id — each Stripe subscription maps to exactly one row.
    const [existingRow] = await tx
      .select({
        instance_id: kiloclaw_subscriptions.instance_id,
        suspended_at: kiloclaw_subscriptions.suspended_at,
        scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
        scheduled_by: kiloclaw_subscriptions.scheduled_by,
        stripe_schedule_id: kiloclaw_subscriptions.stripe_schedule_id,
      })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
      .limit(1);

    wasSuspended = !!existingRow?.suspended_at;
    resolvedInstanceId = existingRow?.instance_id ?? undefined;

    // If a scheduled plan change matches the settled plan, clear the schedule.
    const shouldClearSchedule = existingRow?.scheduled_plan === plan;

    const commitEndsAt = plan === 'commit' ? periodEnd : null;

    // If the row doesn't exist yet (settlement arrived before subscription.created),
    // look up the user's active instance so the INSERT path can populate instance_id.
    let instanceId = existingRow?.instance_id ?? null;
    if (!existingRow) {
      const [activeInstance] = await tx
        .select({ id: kiloclaw_instances.id })
        .from(kiloclaw_instances)
        .where(and(eq(kiloclaw_instances.user_id, userId), isNull(kiloclaw_instances.destroyed_at)))
        .limit(1);
      instanceId = activeInstance?.id ?? null;
    }

    // Upsert the subscription row to hybrid state, keyed on stripe_subscription_id.
    await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        instance_id: instanceId,
        stripe_subscription_id: stripeSubscriptionId,
        payment_source: 'credits',
        plan,
        status: 'active',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        credit_renewal_at: periodEnd,
        commit_ends_at: commitEndsAt,
        past_due_since: null,
        auto_top_up_triggered_for_period: null,
        ...(shouldClearSchedule
          ? { scheduled_plan: null, scheduled_by: null, stripe_schedule_id: null }
          : {}),
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.stripe_subscription_id,
        set: {
          payment_source: 'credits',
          status: 'active',
          plan,
          current_period_start: periodStart,
          current_period_end: periodEnd,
          credit_renewal_at: periodEnd,
          commit_ends_at: commitEndsAt,
          past_due_since: null,
          auto_top_up_triggered_for_period: null,
          ...(shouldClearSchedule
            ? { scheduled_plan: null, scheduled_by: null, stripe_schedule_id: null }
            : {}),
        },
      });
  });

  // Step 2: Post-transaction side effects.

  if (wasSuspended) {
    await autoResumeIfSuspended(userId, resolvedInstanceId);
  }

  // Best-effort Kilo Pass bonus evaluation.
  try {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: userId,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after settlement', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logInfo('Credit settlement completed', {
    user_id: userId,
    plan,
    stripe_subscription_id: stripeSubscriptionId,
    chargeId,
    amountMicrodollars,
  });
}

/**
 * Enroll a user's instance in a KiloClaw hosting plan funded by credits.
 *
 * Deducts the first period's cost from the user's credit balance and creates
 * (or upserts) an active pure-credit subscription. See spec "Credit Enrollment"
 * rules 1-8.
 */
export async function enrollWithCredits(params: {
  userId: string;
  instanceId: string;
  plan: 'commit' | 'standard';
  hadPaidSubscription: boolean;
}): Promise<void> {
  const { userId, instanceId, plan, hadPaidSubscription } = params;

  // First-time standard-plan subscribers get the intro price ($4).
  // Returning subscribers (had a prior paid, non-trial subscription) pay full price ($9).
  // Commit plan has no intro discount. See spec Credit Enrollment rule 3.
  const costMicrodollars =
    plan === 'standard' && !hadPaidSubscription
      ? KILOCLAW_STANDARD_FIRST_MONTH_MICRODOLLARS
      : KILOCLAW_PLAN_COST_MICRODOLLARS[plan];

  // Step 1: Read current state
  const [user] = await db
    .select({
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      kilo_pass_threshold: kilocode_users.kilo_pass_threshold,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    logError('Credit enrollment failed: user not found', { user_id: userId, instanceId });
    throw new Error('User not found');
  }

  const [existingSub] = await db
    .select({
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.instance_id, instanceId))
    .limit(1);

  // Reject if subscription is active, past_due, or unpaid (spec rule 1)
  if (existingSub && existingSub.status !== 'trialing' && existingSub.status !== 'canceled') {
    throw new Error('Cannot enroll: an active subscription already exists. Cancel it first.');
  }

  // Save suspension state for post-transaction auto-resume (spec rule 4)
  const wasSuspended = !!existingSub?.suspended_at;

  // Step 2: Check effective balance (spec rule 3)
  // Effective balance = raw balance + projected Kilo Pass bonus that would
  // be awarded after the deduction by maybeIssueKiloPassBonusFromUsageThreshold.
  // The deduction increments microdollars_used, so project the post-deduction
  // value to correctly evaluate whether the spend crosses the bonus threshold.
  const balance = user.total_microdollars_acquired - user.microdollars_used;
  const projectedBonus = await projectPendingKiloPassBonusMicrodollars({
    userId,
    microdollarsUsed: user.microdollars_used + costMicrodollars,
    kiloPassThreshold: user.kilo_pass_threshold,
  });
  const effectiveBalance = balance + projectedBonus;

  if (effectiveBalance < costMicrodollars) {
    const shortfall = costMicrodollars - effectiveBalance;
    throw new Error(
      `Insufficient credit balance. You need ${shortfall} more microdollars to enroll.`
    );
  }

  // Step 3: Single DB transaction (spec rule 5)
  const now = new Date();
  const periodMonths = plan === 'commit' ? 6 : 1;
  const periodEnd = addMonths(now, periodMonths);
  const periodKey = format(now, 'yyyy-MM');
  const categoryPrefix =
    plan === 'commit'
      ? `kiloclaw-subscription-commit:${instanceId}`
      : `kiloclaw-subscription:${instanceId}`;
  const deductionCategory = `${categoryPrefix}:${periodKey}`;

  await db.transaction(async tx => {
    // 5a: Insert negative credit transaction with period-encoded idempotency key
    const deductionResult = await tx
      .insert(credit_transactions)
      .values({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        amount_microdollars: -costMicrodollars,
        is_free: false,
        description: `KiloClaw ${plan} enrollment`,
        credit_category: deductionCategory,
        check_category_uniqueness: true,
        original_baseline_microdollars_used: user.microdollars_used,
      })
      .onConflictDoNothing();

    const deductionIsNew = (deductionResult.rowCount ?? 0) > 0;

    if (!deductionIsNew) {
      // Duplicate key from prior committed transaction — abort as duplicate attempt
      logInfo('Duplicate credit enrollment attempt', {
        user_id: userId,
        instanceId,
        deductionCategory,
      });
      throw new Error('Enrollment already processed for this billing period.');
    }

    // 5b: Atomically increment microdollars_used so the deduction counts
    //     as spend toward the Kilo Pass bonus unlock threshold.
    await tx
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));

    // 5c: Upsert subscription row as pure credit
    const nowIso = now.toISOString();
    const periodEndIso = periodEnd.toISOString();
    const commitEndsAt = plan === 'commit' ? periodEndIso : null;

    await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        instance_id: instanceId,
        payment_source: 'credits',
        status: 'active',
        plan,
        current_period_start: nowIso,
        current_period_end: periodEndIso,
        credit_renewal_at: periodEndIso,
        stripe_subscription_id: null,
        commit_ends_at: commitEndsAt,
        past_due_since: null,
        cancel_at_period_end: false,
        // DO NOT clear suspended_at or destruction_deadline (spec rule 5d)
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.instance_id,
        targetWhere: isNotNull(kiloclaw_subscriptions.instance_id),
        set: {
          payment_source: 'credits',
          status: 'active',
          plan,
          current_period_start: nowIso,
          current_period_end: periodEndIso,
          credit_renewal_at: periodEndIso,
          stripe_subscription_id: null,
          commit_ends_at: commitEndsAt,
          past_due_since: null,
          cancel_at_period_end: false,
        },
      });
  });

  // Step 4: Post-transaction bonus evaluation (spec rule 6)
  try {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: userId,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after credit enrollment', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 5: Auto-resume if suspended (spec rule 7)
  if (wasSuspended) {
    await autoResumeIfSuspended(userId, instanceId);
  }

  logInfo('Credit enrollment completed', {
    user_id: userId,
    instanceId,
    plan,
    costMicrodollars,
  });
}
