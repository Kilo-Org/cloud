import 'server-only';

import type Stripe from 'stripe';
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import {
  classifyKiloClawCommitInvoice,
  classifyKiloClawCommitTerm,
  createCommitRetirementReviewCase,
  deriveKiloClawCommitFinalBoundary,
  findOpenCommitRetirementReviewCase,
  findProviderCommitRetirementDisposition,
  getKiloClawPlanCostMicrodollars,
  insertKiloClawSubscriptionChangeLog,
  isBeforeKiloClawCommitSalesCutoff,
  maySelectKiloClawCommit,
  type KiloClawCommitInvoiceAuthorization,
  type KiloClawCommitRetirementReviewReason,
  type KiloClawSubscription,
} from '@kilocode/db';
import {
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { getStripePriceIdForClawPlan } from '@/lib/kiloclaw/stripe-price-ids.server';

const RETIREMENT_ACTOR = { actorType: 'system', actorId: 'kiloclaw-commit-retirement' } as const;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const KILOCLAW_COMMIT_RETIRED_MESSAGE =
  'KiloClaw Commit is no longer available. Choose month-to-month Standard instead.';

export type KiloClawCommitEnrollmentQualification = {
  source: 'active_at_cutoff' | 'checkout_confirmed_before_cutoff';
  qualifiedAt: string;
};

export function assertKiloClawCommitAdmission(params: {
  plan: 'commit' | 'standard';
  now?: Date | string;
  qualification?: KiloClawCommitEnrollmentQualification;
}): void {
  if (params.plan !== 'commit') return;

  const qualification = params.qualification;
  if (qualification) {
    if (!isBeforeKiloClawCommitSalesCutoff(qualification.qualifiedAt)) {
      throw new Error(KILOCLAW_COMMIT_RETIRED_MESSAGE);
    }
    return;
  }

  if (!maySelectKiloClawCommit(params.now ?? new Date())) {
    throw new Error(KILOCLAW_COMMIT_RETIRED_MESSAGE);
  }
}

export async function findKiloClawProviderRetirementDisposition(params: {
  stripeSubscriptionId: string;
  stripeEventId?: string;
}): Promise<Awaited<ReturnType<typeof findProviderCommitRetirementDisposition>>> {
  const disposition = await findProviderCommitRetirementDisposition(db, params);
  return disposition?.subscription_id === null ? disposition : null;
}

export type StripeFundedRetirementSettlementDecision = {
  authorization: KiloClawCommitInvoiceAuthorization | 'standard_authorized' | 'not_involved';
  reviewReason: KiloClawCommitRetirementReviewReason | null;
  retirementUpdate: Partial<typeof kiloclaw_subscriptions.$inferInsert>;
};

export function isQualifiedKiloClawCommitPreCutoffRecovery(params: {
  subscription: KiloClawSubscription;
  incomingPeriodStart: string | null;
}): boolean {
  const boundary = params.subscription.current_period_end;
  return (
    params.subscription.plan === 'commit' &&
    params.subscription.commit_retirement_state !== 'manual_review' &&
    params.subscription.commit_retirement_final_ends_at === null &&
    boundary !== null &&
    params.incomingPeriodStart !== null &&
    isBeforeKiloClawCommitSalesCutoff(boundary) &&
    timestampsEqual(boundary, params.incomingPeriodStart)
  );
}

export function getStripeFundedRetirementSettlementDecision(params: {
  subscription: KiloClawSubscription;
  plan: 'commit' | 'standard';
  periodStart: string;
  periodEnd: string;
  checkoutConfirmedAt?: string;
}): StripeFundedRetirementSettlementDecision {
  const { subscription, plan, periodStart, periodEnd } = params;

  if (subscription.commit_retirement_state === 'manual_review') {
    return {
      authorization: 'ambiguous',
      reviewReason: subscription.commit_retirement_review_reason ?? 'provider_state_mismatch',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }

  if (plan === 'standard') {
    const retirementInvolved =
      subscription.plan === 'commit' || subscription.commit_retirement_state !== null;
    if (!retirementInvolved) {
      return { authorization: 'not_involved', reviewReason: null, retirementUpdate: {} };
    }

    const finalBoundary = subscription.commit_retirement_final_ends_at;
    if (
      subscription.commit_retirement_state === 'standard_scheduled' &&
      subscription.commit_retirement_standard_opted_in_at &&
      finalBoundary &&
      timestampsEqual(finalBoundary, periodStart)
    ) {
      return {
        authorization: 'standard_authorized',
        reviewReason: null,
        retirementUpdate: {
          commit_retirement_state: 'completed',
          commit_retirement_review_reason: null,
          commit_ends_at: null,
        },
      };
    }

    return {
      authorization: 'ambiguous',
      reviewReason: 'provider_state_mismatch',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }

  const classificationFinalBoundary =
    subscription.commit_retirement_state === 'pending_final_term'
      ? null
      : subscription.commit_retirement_final_ends_at;
  const qualifiedPreCutoffRecovery = isQualifiedKiloClawCommitPreCutoffRecovery({
    subscription,
    incomingPeriodStart: periodStart,
  });
  const incomingStartsAtOrAfterExistingBoundary =
    subscription.plan === 'commit' &&
    subscription.current_period_end !== null &&
    new Date(periodStart).getTime() >= new Date(subscription.current_period_end).getTime();
  const incomingExtendsExistingCommitPeriod =
    subscription.plan === 'commit' &&
    subscription.current_period_end !== null &&
    new Date(periodEnd).getTime() > new Date(subscription.current_period_end).getTime();
  if (
    !qualifiedPreCutoffRecovery &&
    (incomingStartsAtOrAfterExistingBoundary || incomingExtendsExistingCommitPeriod)
  ) {
    return {
      authorization: 'forbidden_renewal',
      reviewReason: 'forbidden_commit_invoice',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }

  const verifiedCheckoutConfirmedAt =
    subscription.plan !== 'commit' &&
    !subscription.commit_retirement_qualified_at &&
    !subscription.commit_retirement_qualification_source &&
    params.checkoutConfirmedAt &&
    isBeforeKiloClawCommitSalesCutoff(params.checkoutConfirmedAt)
      ? params.checkoutConfirmedAt
      : null;
  const qualifiedAt = subscription.commit_retirement_qualified_at ?? verifiedCheckoutConfirmedAt;
  const qualificationSource =
    subscription.commit_retirement_qualification_source ??
    (verifiedCheckoutConfirmedAt ? 'checkout_confirmed_before_cutoff' : null);
  const authorization = qualifiedPreCutoffRecovery
    ? 'pre_cutoff_recovery'
    : classifyKiloClawCommitInvoice({
        invoicePeriodStart: periodStart,
        invoicePeriodEnd: periodEnd,
        finalEndsAt: classificationFinalBoundary,
        qualifiedAt,
        qualificationSource,
      });

  if (authorization === 'forbidden_renewal') {
    return {
      authorization,
      reviewReason: 'forbidden_commit_invoice',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }
  if (authorization === 'ambiguous') {
    return {
      authorization,
      reviewReason: 'boundary_mismatch',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }

  const settlementQualifiedAt =
    qualifiedAt ?? (isBeforeKiloClawCommitSalesCutoff(periodStart) ? periodStart : null);
  const settlementQualificationSource =
    qualificationSource ?? (settlementQualifiedAt ? 'renewal_due_before_cutoff' : null);

  if (!settlementQualifiedAt || !settlementQualificationSource) {
    return {
      authorization: 'ambiguous',
      reviewReason: 'missing_qualification_evidence',
      retirementUpdate: { cancel_at_period_end: true },
    };
  }

  return {
    authorization,
    reviewReason: null,
    retirementUpdate: {
      commit_retirement_state: 'final_term',
      commit_retirement_qualified_at: settlementQualifiedAt,
      commit_retirement_qualification_source: settlementQualificationSource,
      commit_retirement_final_ends_at: periodEnd,
      commit_retirement_review_reason: null,
      cancel_at_period_end: false,
    },
  };
}

export async function putKiloClawCommitRetirementInReview(params: {
  tx: DbTransaction;
  subscription: KiloClawSubscription;
  reason: KiloClawCommitRetirementReviewReason;
  summary: string;
  stripeEventId?: string;
}): Promise<KiloClawSubscription> {
  const existingCase = await findOpenCommitRetirementReviewCase(params.tx, params.subscription.id);
  let activeReviewReason = existingCase?.reason_code ?? params.reason;
  if (!existingCase) {
    const [reviewHistory] = await params.tx
      .select({ count: count() })
      .from(kiloclaw_commit_retirement_review_cases)
      .where(eq(kiloclaw_commit_retirement_review_cases.subscription_id, params.subscription.id));
    try {
      const reviewCase = await createCommitRetirementReviewCase(params.tx, {
        dedupeKey: buildReviewDedupeKey(
          params.subscription.id,
          params.reason,
          reviewHistory?.count ?? 0
        ),
        subscriptionId: params.subscription.id,
        stripeSubscriptionId: params.subscription.stripe_subscription_id,
        stripeEventId: params.stripeEventId,
        reasonCode: params.reason,
        summary: params.summary,
      });
      activeReviewReason = reviewCase.reason_code;
    } catch (error) {
      if (!isOpenReviewConflict(error)) throw error;
      const conflictingOpenCase = await findOpenCommitRetirementReviewCase(
        params.tx,
        params.subscription.id
      );
      if (!conflictingOpenCase) throw error;
      activeReviewReason = conflictingOpenCase.reason_code;
    }
  }

  const [after] = await params.tx
    .update(kiloclaw_subscriptions)
    .set({
      commit_retirement_state: 'manual_review',
      commit_retirement_review_reason: activeReviewReason,
      cancel_at_period_end: true,
    })
    .where(eq(kiloclaw_subscriptions.id, params.subscription.id))
    .returning();

  if (!after) throw new Error('commit_retirement_review_subscription_missing');
  await insertKiloClawSubscriptionChangeLog(params.tx, {
    subscriptionId: after.id,
    actor: RETIREMENT_ACTOR,
    action: 'commit_retirement_changed',
    reason: activeReviewReason,
    before: params.subscription,
    after,
  });
  return after;
}

export async function recordProviderOnlyCommitRetirementReview(params: {
  tx: DbTransaction;
  stripeSubscriptionId: string;
  stripeEventId: string;
  reason: KiloClawCommitRetirementReviewReason;
  summary: string;
}): Promise<void> {
  await createCommitRetirementReviewCase(params.tx, {
    dedupeKey: `commit-retirement:${params.reason}:${params.stripeSubscriptionId}:${params.stripeEventId}`,
    stripeSubscriptionId: params.stripeSubscriptionId,
    stripeEventId: params.stripeEventId,
    reasonCode: params.reason,
    summary: params.summary,
  });
}

export async function enforceKiloClawCommitRetirementGuard(params: {
  subscriptionId: string;
  expectedFinalBoundary: string;
}): Promise<{ guarded: boolean }> {
  const row = await readPersonalSubscription(params.subscriptionId);
  if (!row) return { guarded: false };
  const subscription = row.subscription;

  if (
    subscription.plan !== 'commit' ||
    subscription.status !== 'active' ||
    !subscription.stripe_subscription_id ||
    subscription.commit_retirement_standard_opted_in_at ||
    subscription.commit_retirement_state === 'standard_scheduled'
  ) {
    return { guarded: false };
  }

  if (
    await findProviderCommitRetirementDisposition(db, {
      stripeSubscriptionId: subscription.stripe_subscription_id,
    })
  ) {
    return { guarded: false };
  }

  const liveSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
  const providerBoundary = getStripeSubscriptionPeriodEnd(liveSubscription);
  const boundary = deriveKiloClawCommitFinalBoundary({
    durableFinalEndsAt: subscription.commit_retirement_final_ends_at,
    localPeriodEndsAt: subscription.current_period_end,
    providerPeriodEndsAt: providerBoundary,
  });

  if (
    boundary.kind !== 'verified' ||
    !timestampsEqual(boundary.finalEndsAt, params.expectedFinalBoundary) ||
    classifyKiloClawCommitTerm(toRetirementEvidence(subscription)) === 'ambiguous'
  ) {
    await markReviewOutsideTransaction(
      subscription,
      'boundary_mismatch',
      'Retirement guard boundary could not be verified.'
    );
    try {
      await makeStripeSubscriptionNonRenewing(liveSubscription);
    } catch {
      await markReviewOutsideTransaction(
        subscription,
        'provider_outcome_unknown',
        'Retirement guard could not confirm provider non-renewal after boundary mismatch.'
      );
    }
    return { guarded: false };
  }

  try {
    await makeStripeSubscriptionNonRenewing(liveSubscription);
  } catch (error) {
    await markReviewOutsideTransaction(
      subscription,
      'provider_outcome_unknown',
      'Retirement guard could not confirm provider non-renewal.'
    );
    throw error;
  }

  const guardedAt = new Date().toISOString();
  let guarded = false;
  let localWinnerChanged = false;
  await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .for('update')
      .limit(1);
    if (!before) return;
    const durableBoundaryMatches = before.commit_retirement_final_ends_at
      ? timestampsEqual(before.commit_retirement_final_ends_at, params.expectedFinalBoundary)
      : true;
    if (
      before.commit_retirement_standard_opted_in_at ||
      before.commit_retirement_state === 'standard_scheduled' ||
      before.commit_retirement_state === 'manual_review' ||
      before.plan !== 'commit' ||
      before.status !== 'active' ||
      before.stripe_subscription_id !== subscription.stripe_subscription_id ||
      !durableBoundaryMatches ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      localWinnerChanged = true;
      return;
    }

    const qualifiedAt = before.commit_retirement_qualified_at ?? before.current_period_start;
    if (!qualifiedAt || !isBeforeKiloClawCommitSalesCutoff(qualifiedAt)) {
      await putKiloClawCommitRetirementInReview({
        tx,
        subscription: before,
        reason: 'missing_qualification_evidence',
        summary: 'Retirement guard found a final Commit term without pre-cutoff qualification.',
      });
      return;
    }

    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: true,
        commit_retirement_state: 'final_term',
        commit_retirement_qualified_at: qualifiedAt,
        commit_retirement_qualification_source:
          before.commit_retirement_qualification_source ?? 'active_at_cutoff',
        commit_retirement_final_ends_at: params.expectedFinalBoundary,
        commit_retirement_guarded_at: guardedAt,
        commit_retirement_review_reason: null,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, before.id),
          eq(kiloclaw_subscriptions.plan, 'commit'),
          eq(kiloclaw_subscriptions.status, 'active'),
          sql`${kiloclaw_subscriptions.stripe_subscription_id} IS NOT DISTINCT FROM ${subscription.stripe_subscription_id}`,
          or(
            isNull(kiloclaw_subscriptions.commit_retirement_final_ends_at),
            eq(kiloclaw_subscriptions.commit_retirement_final_ends_at, params.expectedFinalBoundary)
          ),
          sql`${kiloclaw_subscriptions.current_period_end} IS NOT DISTINCT FROM ${before.current_period_end}`
        )
      )
      .returning();
    if (!after) {
      localWinnerChanged = true;
      return;
    }
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: RETIREMENT_ACTOR,
      action: 'commit_retirement_changed',
      reason: 'commit_retirement_guarded',
      before,
      after,
    });
    guarded = true;
  });

  if (localWinnerChanged) {
    await markReviewOutsideTransaction(
      subscription,
      'provider_state_mismatch',
      'Retirement guard provider non-renewal won while local expected state changed.'
    );
  }

  return { guarded };
}

export async function makeKiloClawStripeSubscriptionNonRenewing(
  stripeSubscriptionId: string
): Promise<void> {
  const live = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  await makeStripeSubscriptionNonRenewing(live);
}

export async function continueKiloClawCommitAsStandard(params: {
  subscriptionId: string;
  userId: string;
  convertToCredits?: boolean;
}): Promise<void> {
  const row = await readPersonalSubscription(params.subscriptionId, params.userId);
  if (!row) throw new Error('KiloClaw subscription not found.');
  const subscription = row.subscription;
  const boundary = requireLiveFinalCommitBoundary(subscription);
  const optedInAt = new Date().toISOString();

  let scheduleId: string | null = null;
  if (subscription.stripe_subscription_id) {
    if (
      await findProviderCommitRetirementDisposition(db, {
        stripeSubscriptionId: subscription.stripe_subscription_id,
      })
    ) {
      throw new Error('Commit retirement provider disposition blocks mutation.');
    }
    const live = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    if (params.convertToCredits) {
      await makeStripeSubscriptionNonRenewing(live);
    } else {
      scheduleId = await scheduleStripeStandardContinuation(subscription, live, boundary);
    }
  } else if (params.convertToCredits) {
    throw new Error('Subscription is already credit-funded.');
  }

  let localWinnerChanged = false;
  await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.id, subscription.id),
          eq(kiloclaw_subscriptions.user_id, params.userId)
        )
      )
      .for('update')
      .limit(1);
    const durableBoundaryMatches = before?.commit_retirement_final_ends_at
      ? timestampsEqual(before.commit_retirement_final_ends_at, boundary)
      : before?.current_period_end
        ? timestampsEqual(before.current_period_end, boundary)
        : false;
    if (
      !before ||
      before.plan !== 'commit' ||
      before.status !== 'active' ||
      before.stripe_subscription_id !== subscription.stripe_subscription_id ||
      before.commit_retirement_state !== subscription.commit_retirement_state ||
      before.commit_retirement_standard_opted_in_at !==
        subscription.commit_retirement_standard_opted_in_at ||
      !durableBoundaryMatches ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      localWinnerChanged = true;
      return;
    }
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        scheduled_plan: 'standard',
        scheduled_by: 'user',
        stripe_schedule_id: scheduleId,
        pending_conversion: params.convertToCredits ?? false,
        cancel_at_period_end: params.convertToCredits ?? false,
        commit_retirement_state: 'standard_scheduled',
        commit_retirement_final_ends_at: boundary,
        commit_retirement_standard_opted_in_at: optedInAt,
        commit_retirement_guarded_at: null,
        commit_retirement_review_reason: null,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, before.id),
          eq(kiloclaw_subscriptions.plan, 'commit'),
          eq(kiloclaw_subscriptions.status, 'active'),
          sql`${kiloclaw_subscriptions.commit_retirement_state} IS NOT DISTINCT FROM ${before.commit_retirement_state}`,
          sql`${kiloclaw_subscriptions.current_period_end} IS NOT DISTINCT FROM ${before.current_period_end}`,
          before.commit_retirement_standard_opted_in_at
            ? eq(
                kiloclaw_subscriptions.commit_retirement_standard_opted_in_at,
                before.commit_retirement_standard_opted_in_at
              )
            : isNull(kiloclaw_subscriptions.commit_retirement_standard_opted_in_at)
        )
      )
      .returning();
    if (!after) {
      localWinnerChanged = true;
      return;
    }
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: { actorType: 'user', actorId: params.userId },
      action: 'commit_retirement_changed',
      reason: params.convertToCredits
        ? 'commit_retirement_standard_conversion_selected'
        : 'commit_retirement_standard_selected',
      before,
      after,
    });
  });

  if (localWinnerChanged) {
    await markReviewOutsideTransaction(
      subscription,
      'provider_state_mismatch',
      'Standard continuation provider mutation won while local expected state changed.'
    );
    throw new Error(
      'Commit final boundary changed. Standard continuation requires support review.'
    );
  }
}

export async function undoKiloClawCommitStandardContinuation(params: {
  subscriptionId: string;
  userId: string;
}): Promise<void> {
  const row = await readPersonalSubscription(params.subscriptionId, params.userId);
  if (!row) throw new Error('KiloClaw subscription not found.');
  const subscription = row.subscription;
  requireLiveFinalCommitBoundary(subscription);
  if (
    subscription.commit_retirement_state !== 'standard_scheduled' ||
    !subscription.commit_retirement_standard_opted_in_at
  ) {
    throw new Error('No Standard continuation is scheduled.');
  }

  if (
    subscription.stripe_subscription_id &&
    (await findProviderCommitRetirementDisposition(db, {
      stripeSubscriptionId: subscription.stripe_subscription_id,
    }))
  ) {
    throw new Error('Commit retirement provider disposition blocks mutation.');
  }
  if (subscription.stripe_subscription_id) {
    await makeKiloClawStripeSubscriptionNonRenewing(subscription.stripe_subscription_id);
  }

  const boundary = subscription.commit_retirement_final_ends_at;
  let localWinnerChanged = false;
  await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.id, subscription.id),
          eq(kiloclaw_subscriptions.user_id, params.userId)
        )
      )
      .for('update')
      .limit(1);
    if (
      !before ||
      before.plan !== 'commit' ||
      before.status !== 'active' ||
      before.stripe_subscription_id !== subscription.stripe_subscription_id ||
      before.stripe_schedule_id !== subscription.stripe_schedule_id ||
      before.commit_retirement_state !== 'standard_scheduled' ||
      before.commit_retirement_standard_opted_in_at !==
        subscription.commit_retirement_standard_opted_in_at ||
      !timestampsEqual(before.commit_retirement_final_ends_at, boundary) ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      localWinnerChanged = true;
      return;
    }
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
        pending_conversion: false,
        cancel_at_period_end: true,
        commit_retirement_state: 'final_term',
        commit_retirement_standard_opted_in_at: null,
        commit_retirement_guarded_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, before.id),
          eq(kiloclaw_subscriptions.plan, 'commit'),
          eq(kiloclaw_subscriptions.status, 'active'),
          eq(kiloclaw_subscriptions.commit_retirement_state, 'standard_scheduled'),
          sql`${kiloclaw_subscriptions.commit_retirement_standard_opted_in_at} IS NOT DISTINCT FROM ${before.commit_retirement_standard_opted_in_at}`,
          sql`${kiloclaw_subscriptions.current_period_end} IS NOT DISTINCT FROM ${before.current_period_end}`
        )
      )
      .returning();
    if (!after) {
      localWinnerChanged = true;
      return;
    }
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: { actorType: 'user', actorId: params.userId },
      action: 'commit_retirement_changed',
      reason: 'commit_retirement_standard_undone',
      before,
      after,
    });
  });

  if (localWinnerChanged) {
    await markReviewOutsideTransaction(
      subscription,
      'provider_state_mismatch',
      'Standard continuation undo made provider non-renewing while local expected state changed.'
    );
    throw new Error(
      'Commit final boundary changed. Standard continuation undo requires support review.'
    );
  }
}

export function getLineageStandardContinuationCost(subscription: KiloClawSubscription): number {
  return getKiloClawPlanCostMicrodollars({
    priceVersion: subscription.kiloclaw_price_version,
    plan: 'standard',
  });
}

async function scheduleStripeStandardContinuation(
  subscription: KiloClawSubscription,
  live: Stripe.Subscription,
  boundary: string
): Promise<string> {
  const existingScheduleId = resolveScheduleId(live.schedule) ?? subscription.stripe_schedule_id;
  let schedule: Stripe.SubscriptionSchedule;
  if (existingScheduleId) {
    const existingSchedule = await stripe.subscriptionSchedules.retrieve(existingScheduleId);
    if (
      subscription.stripe_schedule_id === null &&
      existingSchedule.metadata?.origin !== 'auto-intro' &&
      existingSchedule.metadata?.origin !== 'commit-retirement-standard'
    ) {
      throw new Error('Unexpected Stripe schedule requires support review.');
    }
    schedule = existingSchedule;
  } else {
    schedule = await stripe.subscriptionSchedules.create({ from_subscription: live.id });
  }
  const currentPhase = schedule.phases[0];
  const currentPrice = currentPhase ? resolvePhasePrice(currentPhase) : null;
  if (!currentPhase || !currentPrice) throw new Error('Unable to determine current Stripe phase.');

  await stripe.subscriptionSchedules.update(schedule.id, {
    metadata: { origin: 'commit-retirement-standard' },
    end_behavior: 'release',
    phases: [
      {
        items: [{ price: currentPrice }],
        start_date: currentPhase.start_date,
        end_date: Math.floor(new Date(boundary).getTime() / 1000),
      },
      {
        items: [
          {
            price: getStripePriceIdForClawPlan('standard', {
              priceVersion: subscription.kiloclaw_price_version,
            }),
          },
        ],
      },
    ],
  });
  const confirmedSubscription = await stripe.subscriptions.retrieve(live.id);
  if (
    resolveScheduleId(confirmedSubscription.schedule) !== schedule.id ||
    confirmedSubscription.cancel_at_period_end
  ) {
    throw new Error('stripe_commit_retirement_standard_continuation_not_confirmed');
  }
  return schedule.id;
}

async function makeStripeSubscriptionNonRenewing(live: Stripe.Subscription): Promise<void> {
  const scheduleId = resolveScheduleId(live.schedule);
  if (scheduleId) {
    await stripe.subscriptionSchedules.release(scheduleId);
  }
  await stripe.subscriptions.update(live.id, { cancel_at_period_end: true });
  const confirmed = await stripe.subscriptions.retrieve(live.id);
  if (resolveScheduleId(confirmed.schedule) || !confirmed.cancel_at_period_end) {
    throw new Error('stripe_commit_retirement_nonrenewal_not_confirmed');
  }
}

async function markReviewOutsideTransaction(
  subscription: KiloClawSubscription,
  reason: KiloClawCommitRetirementReviewReason,
  summary: string
): Promise<void> {
  await db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .limit(1);
    if (!current) return;
    await putKiloClawCommitRetirementInReview({ tx, subscription: current, reason, summary });
  });
}

async function readPersonalSubscription(subscriptionId: string, userId?: string) {
  const [row] = await db
    .select({ subscription: kiloclaw_subscriptions })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.id, subscriptionId),
        userId ? eq(kiloclaw_subscriptions.user_id, userId) : undefined,
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);
  return row ?? null;
}

function requireLiveFinalCommitBoundary(subscription: KiloClawSubscription): string {
  if (subscription.plan !== 'commit' || subscription.status !== 'active') {
    throw new Error('Subscription is not an active final Commit term.');
  }
  const classification = classifyKiloClawCommitTerm(toRetirementEvidence(subscription));
  if (
    classification !== 'final_term' ||
    subscription.commit_retirement_state === 'manual_review' ||
    subscription.commit_retirement_state === 'completed'
  ) {
    throw new Error('Commit retirement state requires support review.');
  }
  const boundary = subscription.commit_retirement_final_ends_at ?? subscription.current_period_end;
  if (!boundary || Date.parse(boundary) <= Date.now()) {
    throw new Error('Commit final boundary has passed.');
  }
  return new Date(boundary).toISOString();
}

function toRetirementEvidence(subscription: KiloClawSubscription) {
  return {
    plan: subscription.plan,
    scheduledPlan: subscription.scheduled_plan,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    retirementState: subscription.commit_retirement_state,
    qualifiedAt: subscription.commit_retirement_qualified_at,
    qualificationSource: subscription.commit_retirement_qualification_source,
    finalEndsAt: subscription.commit_retirement_final_ends_at,
    standardOptedInAt: subscription.commit_retirement_standard_opted_in_at,
  };
}

function getStripeSubscriptionPeriodEnd(subscription: Stripe.Subscription): string | null {
  const periodEnd = subscription.items.data[0]?.current_period_end;
  return periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
}

function resolveScheduleId(schedule: string | Stripe.SubscriptionSchedule | null | undefined) {
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

function resolvePhasePrice(phase: Stripe.SubscriptionSchedule.Phase): string | null {
  const price = phase.items[0]?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

function timestampsEqual(
  left: string | Date | null | undefined,
  right: string | Date | null | undefined
) {
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
}

function buildReviewDedupeKey(
  subscriptionId: string,
  reason: KiloClawCommitRetirementReviewReason,
  episode: number
) {
  return `commit-retirement:${reason}:${subscriptionId}:episode:${episode + 1}`;
}

function isOpenReviewConflict(error: unknown) {
  if (typeof error !== 'object' || error === null || !('constraint_name' in error)) return false;
  return error.constraint_name === 'UQ_kiloclaw_commit_retirement_review_cases_open_subscription';
}
