import 'server-only';

import type Stripe from 'stripe';
import { and, eq, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

import { db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import {
  classifyKiloClawCommitInvoice,
  deriveKiloClawCommitFinalBoundary,
  findLatestPreCutoffUserCommitSwitchQualification,
  getKiloClawPlanCostMicrodollars,
  insertKiloClawSubscriptionChangeLog,
  isBeforeKiloClawCommitSalesCutoff,
  maySelectKiloClawCommit,
  type KiloClawCommitInvoiceAuthorization,
  type KiloClawSubscription,
} from '@kilocode/db';
import { kiloclaw_instances, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { getStripePriceIdForClawPlan } from '@/lib/kiloclaw/stripe-price-ids.server';
import { sentryLogger } from '@/lib/utils.server';

const RETIREMENT_ACTOR = { actorType: 'system', actorId: 'kiloclaw-commit-retirement' } as const;
const logWarning = sentryLogger('kiloclaw-commit-retirement', 'warning');
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const KILOCLAW_COMMIT_RETIRED_MESSAGE =
  'KiloClaw Commit is no longer available. Choose month-to-month Standard instead.';

export type KiloClawCommitEnrollmentQualification = {
  source:
    | 'active_at_cutoff'
    | 'checkout_confirmed_before_cutoff'
    | 'switch_requested_before_cutoff';
  qualifiedAt: string;
};

export type KiloClawCommitRetirementReport = {
  reason: string;
  summary: string;
  subscriptionId?: string;
  stripeSubscriptionId?: string | null;
  stripeEventId?: string;
};

export function reportKiloClawCommitRetirementAnomaly(
  report: KiloClawCommitRetirementReport
): void {
  logWarning('KiloClaw Commit retirement anomaly requires support investigation', {
    reason: report.reason,
    summary: report.summary,
    subscription_id: report.subscriptionId ?? null,
    stripe_subscription_id: report.stripeSubscriptionId ?? null,
    stripe_event_id: report.stripeEventId ?? null,
  });
  captureException(new Error(`kiloclaw_commit_retirement:${report.reason}`), {
    tags: { source: 'kiloclaw_commit_retirement', reason: report.reason },
    extra: {
      summary: report.summary,
      subscription_id: report.subscriptionId ?? null,
      stripe_subscription_id: report.stripeSubscriptionId ?? null,
      stripe_event_id: report.stripeEventId ?? null,
    },
  });
}

export function assertKiloClawCommitAdmission(params: {
  plan: 'commit' | 'standard';
  now?: Date | string;
  qualification?: KiloClawCommitEnrollmentQualification;
}): void {
  if (params.plan !== 'commit') return;
  if (params.qualification) {
    if (!isBeforeKiloClawCommitSalesCutoff(params.qualification.qualifiedAt)) {
      throw new Error(KILOCLAW_COMMIT_RETIRED_MESSAGE);
    }
    return;
  }
  if (!maySelectKiloClawCommit(params.now ?? new Date())) {
    throw new Error(KILOCLAW_COMMIT_RETIRED_MESSAGE);
  }
}

export async function findPendingCommitSwitchQualification(
  subscriptionId: string,
  dbOrTx: typeof db | DbTransaction = db
): Promise<KiloClawCommitEnrollmentQualification | null> {
  const qualification = await findLatestPreCutoffUserCommitSwitchQualification(
    dbOrTx,
    subscriptionId
  );
  return qualification
    ? { source: qualification.qualificationSource, qualifiedAt: qualification.qualifiedAt }
    : null;
}

export type StripeFundedRetirementSettlementDecision = {
  authorization: KiloClawCommitInvoiceAuthorization | 'standard_authorized' | 'not_involved';
  anomalyReason: string | null;
  subscriptionUpdate: Partial<typeof kiloclaw_subscriptions.$inferInsert>;
};

type CommitQualificationEvidence = {
  qualifiedAt: string;
  source:
    | 'active_at_cutoff'
    | 'checkout_confirmed_before_cutoff'
    | 'switch_requested_before_cutoff'
    | 'renewal_due_before_cutoff';
};

export function isQualifiedKiloClawCommitPreCutoffRecovery(params: {
  subscription: KiloClawSubscription;
  incomingPeriodStart: string | null;
}): boolean {
  const boundary = params.subscription.current_period_end;
  return (
    params.subscription.plan === 'commit' &&
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
  switchQualification?: KiloClawCommitEnrollmentQualification;
}): StripeFundedRetirementSettlementDecision {
  const { subscription, plan, periodStart, periodEnd } = params;
  if (plan === 'standard') {
    if (subscription.plan !== 'commit' && subscription.commit_ends_at === null) {
      return { authorization: 'not_involved', anomalyReason: null, subscriptionUpdate: {} };
    }
    if (
      subscription.scheduled_plan === 'standard' &&
      subscription.scheduled_by === 'user' &&
      timestampsEqual(subscription.commit_ends_at, periodStart)
    ) {
      return {
        authorization: 'standard_authorized',
        anomalyReason: null,
        subscriptionUpdate: { commit_ends_at: null, cancel_at_period_end: false },
      };
    }
    return {
      authorization: 'ambiguous',
      anomalyReason: 'provider_state_mismatch',
      subscriptionUpdate: {},
    };
  }

  const qualifiedPreCutoffRecovery = isQualifiedKiloClawCommitPreCutoffRecovery({
    subscription,
    incomingPeriodStart: periodStart,
  });
  const qualification = getCommitSettlementQualification({
    subscription,
    periodStart,
    checkoutConfirmedAt: params.checkoutConfirmedAt,
    switchQualification: params.switchQualification,
    qualifiedPreCutoffRecovery,
  });
  const authorization = qualifiedPreCutoffRecovery
    ? 'pre_cutoff_recovery'
    : classifyKiloClawCommitInvoice({
        invoicePeriodStart: periodStart,
        invoicePeriodEnd: periodEnd,
        commitEndsAt: subscription.commit_ends_at,
        qualifiedAt: qualification?.qualifiedAt,
        qualificationSource: qualification?.source,
      });

  if (authorization === 'forbidden_renewal') {
    return { authorization, anomalyReason: 'forbidden_commit_invoice', subscriptionUpdate: {} };
  }
  if (authorization === 'ambiguous' || !qualification) {
    return {
      authorization: 'ambiguous',
      anomalyReason: qualification ? 'boundary_mismatch' : 'missing_qualification_evidence',
      subscriptionUpdate: {},
    };
  }
  return {
    authorization,
    anomalyReason: null,
    subscriptionUpdate: { commit_ends_at: periodEnd, cancel_at_period_end: false },
  };
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
    (subscription.scheduled_plan === 'standard' && subscription.scheduled_by === 'user')
  ) {
    return { guarded: false };
  }

  const live = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
  const boundary = deriveKiloClawCommitFinalBoundary({
    commitEndsAt: subscription.commit_ends_at,
    currentPeriodEndsAt: subscription.current_period_end,
    providerPeriodEndsAt: getStripeSubscriptionPeriodEnd(live),
  });
  if (
    boundary.kind !== 'verified' ||
    !timestampsEqual(boundary.finalEndsAt, params.expectedFinalBoundary)
  ) {
    reportKiloClawCommitRetirementAnomaly({
      reason: 'boundary_mismatch',
      summary:
        boundary.kind === 'verified'
          ? 'Verified retirement boundary no longer matches the expected boundary; provider non-renewal forced.'
          : 'Retirement guard boundary could not be verified; provider non-renewal forced.',
      subscriptionId: subscription.id,
      stripeSubscriptionId: subscription.stripe_subscription_id,
    });
  }

  await makeStripeSubscriptionNonRenewing(live);
  if (boundary.kind !== 'verified') return { guarded: false };

  let guarded = false;
  await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .for('update')
      .limit(1);
    if (
      !before ||
      (before.scheduled_plan === 'standard' && before.scheduled_by === 'user') ||
      before.plan !== 'commit' ||
      before.status !== 'active' ||
      before.stripe_subscription_id !== subscription.stripe_subscription_id ||
      !timestampsEqual(before.commit_ends_at, params.expectedFinalBoundary) ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      reportKiloClawCommitRetirementAnomaly({
        reason: 'provider_state_mismatch',
        summary: 'Provider non-renewal succeeded while local expected state changed.',
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripe_subscription_id,
      });
      return;
    }
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({ cancel_at_period_end: true, commit_ends_at: params.expectedFinalBoundary })
      .where(eq(kiloclaw_subscriptions.id, before.id))
      .returning();
    if (!after) return;
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: RETIREMENT_ACTOR,
      action: 'schedule_changed',
      reason: 'commit_retirement_guarded',
      before,
      after,
    });
    guarded = true;
  });
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
  let scheduleId: string | null = null;
  if (subscription.stripe_subscription_id) {
    const live = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    if (params.convertToCredits) await makeStripeSubscriptionNonRenewing(live);
    else scheduleId = await scheduleStripeStandardContinuation(subscription, live, boundary);
  } else if (params.convertToCredits) {
    throw new Error('Subscription is already credit-funded.');
  }

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
      !timestampsEqual(before.commit_ends_at, boundary) ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      reportKiloClawCommitRetirementAnomaly({
        reason: 'provider_state_mismatch',
        summary: 'Standard continuation provider mutation won while local expected state changed.',
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripe_subscription_id,
      });
      throw new Error(
        'Commit final boundary changed. Standard continuation requires support investigation.'
      );
    }
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        scheduled_plan: 'standard',
        scheduled_by: 'user',
        stripe_schedule_id: scheduleId,
        pending_conversion: params.convertToCredits ?? false,
        cancel_at_period_end: params.convertToCredits ?? false,
        commit_ends_at: boundary,
      })
      .where(eq(kiloclaw_subscriptions.id, before.id))
      .returning();
    if (!after) return;
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: { actorType: 'user', actorId: params.userId },
      action: 'schedule_changed',
      reason: params.convertToCredits
        ? 'commit_retirement_standard_conversion_selected'
        : 'commit_retirement_standard_selected',
      before,
      after,
    });
  });
}

export async function undoKiloClawCommitStandardContinuation(params: {
  subscriptionId: string;
  userId: string;
}): Promise<void> {
  const row = await readPersonalSubscription(params.subscriptionId, params.userId);
  if (!row) throw new Error('KiloClaw subscription not found.');
  const subscription = row.subscription;
  const boundary = requireLiveFinalCommitBoundary(subscription);
  if (subscription.scheduled_plan !== 'standard' || subscription.scheduled_by !== 'user') {
    throw new Error('No Standard continuation is scheduled.');
  }
  if (subscription.stripe_subscription_id) {
    await makeKiloClawStripeSubscriptionNonRenewing(subscription.stripe_subscription_id);
  }
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
      before.scheduled_plan !== 'standard' ||
      before.scheduled_by !== 'user' ||
      !timestampsEqual(before.commit_ends_at, boundary) ||
      !timestampsEqual(before.current_period_end, subscription.current_period_end)
    ) {
      reportKiloClawCommitRetirementAnomaly({
        reason: 'provider_state_mismatch',
        summary: 'Continuation undo made provider non-renewing while local state changed.',
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripe_subscription_id,
      });
      throw new Error(
        'Commit final boundary changed. Standard continuation undo requires support investigation.'
      );
    }
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
        pending_conversion: false,
        cancel_at_period_end: true,
      })
      .where(eq(kiloclaw_subscriptions.id, before.id))
      .returning();
    if (!after) return;
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: after.id,
      actor: { actorType: 'user', actorId: params.userId },
      action: 'schedule_changed',
      reason: 'commit_retirement_standard_undone',
      before,
      after,
    });
  });
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
  const schedule = existingScheduleId
    ? await stripe.subscriptionSchedules.retrieve(existingScheduleId)
    : await stripe.subscriptionSchedules.create({ from_subscription: live.id });
  if (
    existingScheduleId &&
    subscription.stripe_schedule_id === null &&
    schedule.metadata?.origin !== 'auto-intro' &&
    schedule.metadata?.origin !== 'commit-retirement-standard'
  ) {
    throw new Error('Unexpected Stripe schedule requires support investigation.');
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
  const confirmed = await stripe.subscriptions.retrieve(live.id);
  if (resolveScheduleId(confirmed.schedule) !== schedule.id || confirmed.cancel_at_period_end) {
    throw new Error('stripe_commit_retirement_standard_continuation_not_confirmed');
  }
  return schedule.id;
}

async function makeStripeSubscriptionNonRenewing(live: Stripe.Subscription): Promise<void> {
  try {
    const scheduleId = resolveScheduleId(live.schedule);
    if (scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
    await stripe.subscriptions.update(live.id, { cancel_at_period_end: true });
    const confirmed = await stripe.subscriptions.retrieve(live.id);
    if (resolveScheduleId(confirmed.schedule) || !confirmed.cancel_at_period_end) {
      throw new Error('stripe_commit_retirement_nonrenewal_not_confirmed');
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'kiloclaw_commit_retirement', reason: 'provider_outcome_unknown' },
      extra: { stripe_subscription_id: live.id },
    });
    throw error;
  }
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
  const boundary = subscription.commit_ends_at;
  if (
    subscription.plan !== 'commit' ||
    subscription.status !== 'active' ||
    !boundary ||
    !timestampsEqual(boundary, subscription.current_period_end) ||
    Date.parse(boundary) <= Date.now()
  ) {
    throw new Error('Commit final boundary has passed or is unverified.');
  }
  return new Date(boundary).toISOString();
}

function getDirectCommitQualification(
  subscription: KiloClawSubscription
): CommitQualificationEvidence | null {
  if (
    subscription.plan === 'commit' &&
    subscription.current_period_start &&
    isBeforeKiloClawCommitSalesCutoff(subscription.current_period_start)
  ) {
    return { qualifiedAt: subscription.current_period_start, source: 'active_at_cutoff' };
  }
  return null;
}

function getCommitSettlementQualification(params: {
  subscription: KiloClawSubscription;
  periodStart: string;
  checkoutConfirmedAt?: string;
  switchQualification?: KiloClawCommitEnrollmentQualification;
  qualifiedPreCutoffRecovery: boolean;
}): CommitQualificationEvidence | null {
  const activeTerm = getDirectCommitQualification(params.subscription);
  if (activeTerm) return activeTerm;
  if (
    params.switchQualification?.source === 'switch_requested_before_cutoff' &&
    isBeforeKiloClawCommitSalesCutoff(params.switchQualification.qualifiedAt)
  ) {
    return params.switchQualification;
  }
  if (params.qualifiedPreCutoffRecovery) {
    return { qualifiedAt: params.periodStart, source: 'renewal_due_before_cutoff' };
  }
  if (
    params.subscription.plan !== 'commit' &&
    params.checkoutConfirmedAt &&
    isBeforeKiloClawCommitSalesCutoff(params.checkoutConfirmedAt)
  ) {
    return {
      qualifiedAt: params.checkoutConfirmedAt,
      source: 'checkout_confirmed_before_cutoff',
    };
  }
  if (isBeforeKiloClawCommitSalesCutoff(params.periodStart)) {
    return { qualifiedAt: params.periodStart, source: 'renewal_due_before_cutoff' };
  }
  return null;
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
