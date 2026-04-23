import 'server-only';

import type Stripe from 'stripe';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { addMonths } from 'date-fns';

import { db } from '@/lib/drizzle';
import { insertKiloClawSubscriptionChangeLog, type KiloClawSubscription } from '@kilocode/db';
import { kiloclaw_subscriptions, kiloclaw_instances, kilocode_users } from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  getClawPlanForStripePriceId,
  getKnownStripePriceIdsForKiloClaw,
  getStripePriceIdForClawPlan,
  isIntroPriceId,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import { applyStripeFundedKiloClawPeriod } from '@/lib/kiloclaw/credit-billing';
import {
  autoResumeIfSuspended,
  clearTrialInactivityStopAfterTrialTransition,
} from '@/lib/kiloclaw/instance-lifecycle';
import { sentryLogger } from '@/lib/utils.server';
import PostHogClient from '@/lib/posthog';
import { after } from 'next/server';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { client as stripe } from '@/lib/stripe-client';
import { buildAffiliateEventDedupeKey, enqueueAffiliateEventForUser } from '@/lib/affiliate-events';
import { IMPACT_ORDER_ID_MACRO } from '@/lib/impact';
import {
  CurrentPersonalSubscriptionResolutionError,
  resolveCurrentPersonalSubscriptionRow,
} from '@/lib/kiloclaw/current-personal-subscription';

const logInfo = sentryLogger('kiloclaw-stripe', 'info');
const logWarning = sentryLogger('kiloclaw-stripe', 'warning');
const logError = sentryLogger('kiloclaw-stripe', 'error');
const STRIPE_WEBHOOK_ACTOR = {
  actorType: 'system',
  actorId: 'stripe-webhook',
} as const;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type SubscriptionLogWriter = DbTransaction | typeof db;

type KiloClawSubscriptionMetadata = {
  type: 'kiloclaw';
  plan: 'commit' | 'standard';
  kiloUserId: string;
  instanceId: string | null;
  billingContext: 'personal' | null;
  affiliateTrackingId?: string;
};

function getKiloClawMetadata(
  metadata: Stripe.Metadata | null | undefined
): KiloClawSubscriptionMetadata | null {
  if (!metadata || metadata.type !== 'kiloclaw') return null;
  const plan = metadata.plan;
  const kiloUserId = metadata.kiloUserId;
  if (!plan || !kiloUserId) return null;
  if (plan !== 'commit' && plan !== 'standard') return null;
  return {
    type: 'kiloclaw',
    plan,
    kiloUserId,
    instanceId: typeof metadata.instanceId === 'string' ? metadata.instanceId : null,
    billingContext: metadata.billingContext === 'personal' ? 'personal' : null,
    affiliateTrackingId: metadata.affiliateTrackingId || metadata.impactClickId || undefined,
  };
}

function getImpactItemCategory(plan: 'commit' | 'standard') {
  return `kiloclaw-${plan}`;
}

function getImpactItemName(plan: 'commit' | 'standard') {
  return plan === 'commit' ? 'KiloClaw Commit Plan' : 'KiloClaw Standard Plan';
}

function logQuarantinedStripeEvent(
  reason: string,
  fields: Record<string, string | number | boolean | null | undefined>
) {
  logWarning('KiloClaw Stripe event quarantined', {
    event: 'kiloclaw_stripe_quarantine',
    reason,
    ...fields,
  });
}

async function insertStripeSubscriptionChangeLog(
  tx: SubscriptionLogWriter,
  params: {
    subscriptionId: string | null | undefined;
    action:
      | 'created'
      | 'status_changed'
      | 'canceled'
      | 'payment_source_changed'
      | 'schedule_changed'
      | 'plan_switched';
    reason: string;
    before: KiloClawSubscription | null;
    after: KiloClawSubscription | null;
    bestEffort?: boolean;
  }
) {
  if (!params.after || !params.subscriptionId) {
    return;
  }

  try {
    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: params.subscriptionId,
      actor: STRIPE_WEBHOOK_ACTOR,
      action: params.action,
      reason: params.reason,
      before: params.before,
      after: params.after,
    });
  } catch (error) {
    if (!params.bestEffort) {
      throw error;
    }
    logError('Failed to write Stripe subscription change log', {
      subscription_id: params.subscriptionId,
      action: params.action,
      reason: params.reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clearTrialInactivityStopAfterStripeTrialTransition(params: {
  userId: string;
  before: KiloClawSubscription | null;
  after: KiloClawSubscription | null;
}) {
  const before = params.before;
  const after = params.after;

  if (!before || before.plan !== 'trial' || before.status !== 'trialing' || !after?.instance_id) {
    return;
  }

  if (after.plan === 'trial' && after.status === 'trialing') {
    return;
  }

  try {
    await clearTrialInactivityStopAfterTrialTransition({
      kiloUserId: params.userId,
      instanceId: after.instance_id,
    });
  } catch (error) {
    logWarning('Failed to clear trial inactivity marker after Stripe trial transition', {
      user_id: params.userId,
      instance_id: after.instance_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type PersonalSubscriptionWithContext = {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  organizationId: string | null;
};

class PersonalStripeResolutionError extends Error {
  readonly reason: string;
  readonly details: Record<string, string | number | boolean | null | undefined>;

  constructor(
    reason: string,
    details: Record<string, string | number | boolean | null | undefined> = {}
  ) {
    super(reason);
    this.name = 'PersonalStripeResolutionError';
    this.reason = reason;
    this.details = details;
  }
}

async function selectPersonalSubscriptionById(
  tx: DbTransaction,
  subscriptionId: string
): Promise<PersonalSubscriptionWithContext | null> {
  const [row] = await tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(eq(kiloclaw_subscriptions.id, subscriptionId))
    .limit(1);

  return row ?? null;
}

async function selectPersonalSubscriptionsByStripeId(
  tx: DbTransaction,
  stripeSubscriptionId: string
): Promise<PersonalSubscriptionWithContext[]> {
  return await tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    .limit(2);
}

async function selectPersonalSubscriptionByInstanceId(params: {
  tx: DbTransaction;
  userId: string;
  instanceId: string;
}): Promise<PersonalSubscriptionWithContext | null> {
  const [row] = await params.tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.instance_id, params.instanceId),
        eq(kiloclaw_subscriptions.user_id, params.userId),
        eq(kiloclaw_instances.user_id, params.userId),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);

  return row ?? null;
}

async function selectCurrentPersonalSubscriptionTarget(
  tx: DbTransaction,
  userId: string
): Promise<PersonalSubscriptionWithContext | null> {
  try {
    const row = await resolveCurrentPersonalSubscriptionRow({ userId, dbOrTx: tx });
    if (!row) {
      return null;
    }
    return {
      subscription: row.subscription,
      organizationId: row.instance?.organizationId ?? null,
    };
  } catch (error) {
    if (error instanceof CurrentPersonalSubscriptionResolutionError) {
      throw new PersonalStripeResolutionError('multiple_current_rows', {
        user_id: userId,
        instance_id: error.instanceId,
      });
    }
    throw error;
  }
}

function assertPersonalStripeRow(
  row: PersonalSubscriptionWithContext,
  userId: string
): PersonalSubscriptionWithContext {
  if (row.subscription.user_id !== userId) {
    throw new PersonalStripeResolutionError('user_mismatch', {
      subscription_id: row.subscription.id,
      row_user_id: row.subscription.user_id,
      user_id: userId,
    });
  }

  if (row.organizationId !== null) {
    throw new PersonalStripeResolutionError('org_boundary', {
      subscription_id: row.subscription.id,
      organization_id: row.organizationId,
      user_id: userId,
    });
  }

  return row;
}

async function followTransferredPersonalSubscription(params: {
  tx: DbTransaction;
  start: PersonalSubscriptionWithContext;
  userId: string;
}): Promise<PersonalSubscriptionWithContext> {
  let current = assertPersonalStripeRow(params.start, params.userId);
  const seen = new Set([current.subscription.id]);

  for (let hops = 0; hops < 8; hops += 1) {
    const nextId = current.subscription.transferred_to_subscription_id;
    if (!nextId) {
      return current;
    }

    const next = await selectPersonalSubscriptionById(params.tx, nextId);
    if (!next) {
      throw new PersonalStripeResolutionError('missing_lineage_target', {
        subscription_id: current.subscription.id,
        transferred_to_subscription_id: nextId,
        user_id: params.userId,
      });
    }

    current = assertPersonalStripeRow(next, params.userId);
    if (seen.has(current.subscription.id)) {
      throw new PersonalStripeResolutionError('lineage_cycle', {
        subscription_id: current.subscription.id,
        user_id: params.userId,
      });
    }
    seen.add(current.subscription.id);
  }

  throw new PersonalStripeResolutionError('lineage_hop_limit', {
    subscription_id: params.start.subscription.id,
    user_id: params.userId,
  });
}

async function clearTransferredStripeOwnership(params: {
  tx: DbTransaction;
  row: PersonalSubscriptionWithContext;
  reason: string;
}) {
  if (!params.row.subscription.transferred_to_subscription_id) {
    return;
  }

  const [after] = await params.tx
    .update(kiloclaw_subscriptions)
    .set({
      payment_source: 'credits',
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      cancel_at_period_end: false,
    })
    .where(eq(kiloclaw_subscriptions.id, params.row.subscription.id))
    .returning();

  await insertStripeSubscriptionChangeLog(params.tx, {
    subscriptionId: params.row.subscription.id,
    action: 'status_changed',
    reason: params.reason,
    before: params.row.subscription,
    after: after ?? null,
  });
}

async function runAfterResponse(work: () => Promise<void>) {
  if (IS_IN_AUTOMATED_TEST) {
    await work();
    return;
  }

  after(work);
}

function getSubscriptionPeriods(subscription: Stripe.Subscription, kiloUserId?: string) {
  // Stripe moved period timestamps to the item level (not the top-level subscription object).
  const item = subscription.items.data[0];
  if (!item) {
    logWarning('Subscription has no items', {
      stripe_subscription_id: subscription.id,
      ...(kiloUserId ? { user_id: kiloUserId } : {}),
    });
  }
  return {
    current_period_start: item ? new Date(item.current_period_start * 1000).toISOString() : null,
    current_period_end: item ? new Date(item.current_period_end * 1000).toISOString() : null,
  };
}

/**
 * Detect the plan from a Stripe subscription's price ID.
 * Falls back to metadata if price lookup fails.
 */
function detectPlanFromSubscription(
  subscription: Stripe.Subscription,
  metadataPlan: 'commit' | 'standard'
): 'commit' | 'standard' {
  const priceId = subscription.items?.data[0]?.price?.id;
  const planFromPrice = priceId ? getClawPlanForStripePriceId(priceId) : null;
  return planFromPrice ?? metadataPlan;
}

const STRIPE_TO_CLAW_STATUS: Record<string, KiloClawSubscriptionStatus> = {
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'unpaid',
  incomplete: 'unpaid',
  incomplete_expired: 'canceled',
  paused: 'canceled',
};

/**
 * Map a Stripe subscription status to our internal status.
 * Only called for paid plans (commit/standard). Pre-launch subscriptions
 * were created with a delayed trial_end — treat 'trialing' as active.
 *
 * TODO: Remove the trialing→active mapping once all pre-launch trial_end
 * subscriptions have transitioned (after ~2026-03-23).
 */
function mapStripeStatus(stripeStatus: string): KiloClawSubscriptionStatus {
  if (stripeStatus === 'trialing') return 'active';
  return STRIPE_TO_CLAW_STATUS[stripeStatus] ?? 'active';
}

// Re-export for backward compatibility — callers that imported from this
// module continue to work without changing their import paths.
export { autoResumeIfSuspended } from '@/lib/kiloclaw/instance-lifecycle';

function resolveScheduleId(
  schedule: string | Stripe.SubscriptionSchedule | null | undefined
): string | null {
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

export function resolvePhasePrice(phase: Stripe.SubscriptionSchedule.Phase): string | null {
  const priceRef = phase.items[0]?.price;
  if (!priceRef) return null;
  return typeof priceRef === 'string' ? priceRef : (priceRef.id ?? null);
}

async function persistAutoIntroSchedule(
  scheduleId: string,
  stripeSubscriptionId: string
): Promise<void> {
  await db.transaction(async tx => {
    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
      .limit(1);
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        stripe_schedule_id: scheduleId,
        scheduled_plan: 'standard',
        scheduled_by: 'auto',
      })
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
      .returning();

    await insertStripeSubscriptionChangeLog(tx, {
      subscriptionId: after?.id ?? before?.id ?? '',
      action: 'schedule_changed',
      reason: 'persist_auto_intro_schedule',
      before: before ?? null,
      after: after ?? null,
    });
  });
}

/**
 * Determine whether a schedule is auto-intro (already tagged) or a claimable
 * orphan (untagged, single-phase — likely a half-created auto-intro where
 * create succeeded but the update that sets metadata + phases never ran).
 * If orphaned, tags it as auto-intro before returning. Returns true when the
 * schedule should be treated as auto-intro, false otherwise.
 */
async function claimIfAutoIntro(schedule: Stripe.SubscriptionSchedule): Promise<boolean> {
  if (schedule.metadata?.origin === 'auto-intro') return true;

  // Only claim untagged schedules with a single phase (the from_subscription
  // default). Schedules with 2+ phases were already configured by another code
  // path (user plan switch, kilo-pass) and must not be claimed.
  const isOrphan = !schedule.metadata?.origin && schedule.phases.length === 1;
  if (!isOrphan) return false;

  await stripe.subscriptionSchedules.update(schedule.id, {
    metadata: { origin: 'auto-intro' },
  });
  return true;
}

/**
 * Validate that an auto-intro schedule has the expected 2-phase structure
 * (phase 1 = current price, phase 2 = regular standard price). If the schedule
 * is half-configured (e.g., created from_subscription but the 2-phase rewrite
 * never completed), rewrite it now and persist. Returns true if the schedule
 * is valid (or was repaired), false if unrecoverable.
 */
async function validateOrRepairAutoIntroSchedule(
  schedule: Stripe.SubscriptionSchedule,
  stripeSubscriptionId: string
): Promise<boolean> {
  // If the user has repurposed this schedule via switchPlan (scheduled_by = 'user'),
  // do not overwrite their pending plan switch. switchPlan reuses the auto-intro
  // schedule but doesn't change metadata.origin, so it still reads as 'auto-intro'.
  const [dbRow] = await db
    .select({ scheduled_by: kiloclaw_subscriptions.scheduled_by })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    .limit(1);

  if (dbRow?.scheduled_by === 'user') {
    return true;
  }

  const regularPriceId = getStripePriceIdForClawPlan('standard');
  const phase2Price = schedule.phases[1] ? resolvePhasePrice(schedule.phases[1]) : null;

  if (schedule.phases.length >= 2 && phase2Price === regularPriceId) {
    await persistAutoIntroSchedule(schedule.id, stripeSubscriptionId);
    return true;
  }

  // Half-configured: rewrite to add the regular-price phase
  const existingPhase = schedule.phases[0];
  const existingPhasePrice = existingPhase ? resolvePhasePrice(existingPhase) : null;
  if (!existingPhase || !existingPhasePrice) {
    logError('Half-configured auto-intro schedule has no usable phase', {
      stripe_subscription_id: stripeSubscriptionId,
      schedule_id: schedule.id,
    });
    return false;
  }

  await stripe.subscriptionSchedules.update(schedule.id, {
    phases: [
      {
        items: [{ price: existingPhasePrice }],
        start_date: existingPhase.start_date,
        end_date: existingPhase.end_date,
      },
      {
        items: [{ price: regularPriceId }],
      },
    ],
    end_behavior: 'release',
  });
  await persistAutoIntroSchedule(schedule.id, stripeSubscriptionId);
  return true;
}

/**
 * Ensure an intro-price subscription has a 2-phase schedule that automatically
 * transitions to the regular standard price at the end of the intro period.
 *
 * No-ops if the subscription is not on an intro price or already has a valid
 * auto-intro schedule attached.
 */
export async function ensureAutoIntroSchedule(
  stripeSubscriptionId: string,
  _userId?: string
): Promise<void> {
  const liveSub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

  const priceId = liveSub.items.data[0]?.price?.id;
  if (!priceId || !isIntroPriceId(priceId)) return;

  // Schedule already attached — persist if auto-intro, skip otherwise
  if (liveSub.schedule) {
    const scheduleId = resolveScheduleId(liveSub.schedule);
    if (!scheduleId) return;
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);

    if (await claimIfAutoIntro(schedule)) {
      const valid = await validateOrRepairAutoIntroSchedule(schedule, stripeSubscriptionId);
      if (!valid) {
        logError('Auto-intro schedule is unrecoverable, skipping', {
          stripe_subscription_id: stripeSubscriptionId,
          schedule_id: schedule.id,
        });
      }
      return;
    }

    logWarning('Subscription has non-auto-intro schedule attached, skipping auto schedule', {
      stripe_subscription_id: stripeSubscriptionId,
      schedule_id: schedule.id,
    });
    return;
  }

  // Clear stale schedule pointer if Stripe says no schedule
  const [existingRow] = await db
    .select({ stripe_schedule_id: kiloclaw_subscriptions.stripe_schedule_id })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    .limit(1);

  if (existingRow?.stripe_schedule_id) {
    await db.transaction(async tx => {
      const [before] = await tx
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
        .limit(1);
      const [after] = await tx
        .update(kiloclaw_subscriptions)
        .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
        .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
        .returning();

      await insertStripeSubscriptionChangeLog(tx, {
        subscriptionId: after?.id ?? before?.id ?? '',
        action: 'schedule_changed',
        reason: 'clear_stale_auto_intro_schedule',
        before: before ?? null,
        after: after ?? null,
      });
    });
  }

  await createAutoIntroSchedule(stripeSubscriptionId);
}

/**
 * Create a new 2-phase auto-intro schedule (intro → regular standard) for a
 * subscription. Handles the race where a concurrent caller attaches a schedule
 * between our check and the create call.
 */
async function createAutoIntroSchedule(stripeSubscriptionId: string): Promise<void> {
  let newSchedule: Stripe.SubscriptionSchedule;
  try {
    newSchedule = await stripe.subscriptionSchedules.create({
      from_subscription: stripeSubscriptionId,
    });
  } catch (error) {
    await handleAutoIntroCreateRace(error, stripeSubscriptionId);
    return;
  }

  const currentPhase = newSchedule.phases[0];
  const phase1Price = currentPhase ? resolvePhasePrice(currentPhase) : null;
  if (!currentPhase || !phase1Price) {
    logError('Auto-intro schedule created with unusable phase', {
      stripe_subscription_id: stripeSubscriptionId,
      schedule_id: newSchedule.id,
      has_phase: !!currentPhase,
      has_price: !!phase1Price,
    });
    return;
  }

  try {
    await stripe.subscriptionSchedules.update(newSchedule.id, {
      metadata: { origin: 'auto-intro' },
      phases: [
        {
          items: [{ price: phase1Price }],
          start_date: currentPhase.start_date,
          end_date: currentPhase.end_date,
        },
        {
          items: [{ price: getStripePriceIdForClawPlan('standard') }],
        },
      ],
      end_behavior: 'release',
    });
  } catch (error) {
    // Release the half-created schedule so retry can start fresh — without
    // metadata, recovery paths cannot identify it as auto-intro.
    try {
      await stripe.subscriptionSchedules.release(newSchedule.id);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }

  await persistAutoIntroSchedule(newSchedule.id, stripeSubscriptionId);
}

/**
 * Handle a failed subscriptionSchedules.create call during auto-intro setup.
 * If the failure was a race (another caller attached a schedule concurrently),
 * validate/repair the winning schedule. Otherwise re-throw.
 */
async function handleAutoIntroCreateRace(
  error: unknown,
  stripeSubscriptionId: string
): Promise<void> {
  const refetched = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const refetchedScheduleId = resolveScheduleId(refetched.schedule);
  if (!refetchedScheduleId) {
    logError('Failed to create auto-intro schedule (non-race error)', {
      stripe_subscription_id: stripeSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logWarning('Race creating auto-intro schedule, re-checking subscription', {
    stripe_subscription_id: stripeSubscriptionId,
    error: error instanceof Error ? error.message : String(error),
  });

  const existingSchedule = await stripe.subscriptionSchedules.retrieve(refetchedScheduleId);

  if (await claimIfAutoIntro(existingSchedule)) {
    const valid = await validateOrRepairAutoIntroSchedule(existingSchedule, stripeSubscriptionId);
    if (!valid) {
      logError('Race-recovered auto-intro schedule is unrecoverable', {
        stripe_subscription_id: stripeSubscriptionId,
        schedule_id: existingSchedule.id,
      });
    }
  }
}

/**
 * Handle customer.subscription.created for KiloClaw subscriptions.
 * After persisting, creates an auto intro→regular schedule if on an intro price.
 */
export async function handleKiloClawSubscriptionCreated(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.created missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const plan = detectPlanFromSubscription(subscription, metadata.plan);
  let kiloUserId = metadata.kiloUserId;
  const periods = getSubscriptionPeriods(subscription, kiloUserId);
  const status = mapStripeStatus(subscription.status);

  let wasSuspended = false;
  let didProcess = false;
  let resolvedInstanceId: string | undefined;
  let convertedFromTrial = false;
  let beforeSubscriptionForMarkerClear: KiloClawSubscription | null = null;
  let afterSubscriptionForMarkerClear: KiloClawSubscription | null = null;
  const trialEndEventDate =
    typeof subscription.created === 'number' ? new Date(subscription.created * 1000) : new Date();

  await db.transaction(async tx => {
    const stripeRows = await selectPersonalSubscriptionsByStripeId(tx, subscription.id);
    if (stripeRows.length > 1) {
      logQuarantinedStripeEvent('duplicate_stripe_subscription_id', {
        stripe_event_id: eventId,
        stripe_subscription_id: subscription.id,
        user_id: metadata.kiloUserId,
      });
      return;
    }

    const stripeOwnerRow = stripeRows[0] ?? null;
    kiloUserId = stripeOwnerRow?.subscription.user_id ?? metadata.kiloUserId;

    let resolvedTarget: PersonalSubscriptionWithContext | null = null;
    try {
      if (stripeOwnerRow) {
        resolvedTarget = await followTransferredPersonalSubscription({
          tx,
          start: stripeOwnerRow,
          userId: kiloUserId,
        });
      } else if (metadata.instanceId) {
        const metadataRow = await selectPersonalSubscriptionByInstanceId({
          tx,
          userId: kiloUserId,
          instanceId: metadata.instanceId,
        });
        if (metadataRow) {
          resolvedTarget = await followTransferredPersonalSubscription({
            tx,
            start: metadataRow,
            userId: kiloUserId,
          });
        }
      } else {
        const currentRow = await selectCurrentPersonalSubscriptionTarget(tx, kiloUserId);
        if (currentRow) {
          resolvedTarget = await followTransferredPersonalSubscription({
            tx,
            start: currentRow,
            userId: kiloUserId,
          });
        }
      }
    } catch (error) {
      if (error instanceof PersonalStripeResolutionError) {
        logQuarantinedStripeEvent(error.reason, {
          stripe_event_id: eventId,
          stripe_subscription_id: subscription.id,
          user_id: kiloUserId,
          metadata_instance_id: metadata.instanceId,
          ...error.details,
        });
        return;
      }
      throw error;
    }

    if (!resolvedTarget || !resolvedTarget.subscription.instance_id) {
      logQuarantinedStripeEvent('missing_personal_instance_target', {
        stripe_event_id: eventId,
        stripe_subscription_id: subscription.id,
        user_id: kiloUserId,
        metadata_instance_id: metadata.instanceId,
      });
      return;
    }

    if (stripeOwnerRow && stripeOwnerRow.subscription.id !== resolvedTarget.subscription.id) {
      await clearTransferredStripeOwnership({
        tx,
        row: stripeOwnerRow,
        reason: 'stripe_subscription_reconciled_to_successor',
      });
    }

    const existingRow = resolvedTarget.subscription;

    if (
      existingRow.stripe_subscription_id !== null &&
      existingRow.stripe_subscription_id !== subscription.id &&
      existingRow.status !== 'canceled'
    ) {
      logWarning(
        'Ignoring stale subscription.created — instance already has a different subscription',
        {
          stripe_event_id: eventId,
          stale_subscription_id: subscription.id,
          current_subscription_id: existingRow.stripe_subscription_id,
          instance_id: existingRow.instance_id,
        }
      );
      return;
    }

    wasSuspended = !!existingRow.suspended_at;
    const retainsTrialHistory =
      existingRow.trial_started_at !== null || existingRow.trial_ends_at !== null;
    convertedFromTrial =
      existingRow.status === 'trialing' ||
      (existingRow.status !== 'canceled' &&
        retainsTrialHistory &&
        existingRow.stripe_subscription_id === subscription.id);
    resolvedInstanceId = existingRow.instance_id ?? undefined;
    const [beforeSubscription] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, existingRow.id))
      .limit(1);

    // For commit plans, derive commit_ends_at. Pre-launch subscriptions
    // had a delayed-billing trial_end — the 6-month commit term starts
    // after the trial boundary, not at subscription creation time.
    const commitEndsAt =
      plan === 'commit'
        ? addMonths(
            subscription.trial_end
              ? new Date(subscription.trial_end * 1000)
              : periods.current_period_start
                ? new Date(periods.current_period_start)
                : new Date(),
            6
          ).toISOString()
        : null;

    const [afterSubscription] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        stripe_subscription_id: subscription.id,
        cancel_at_period_end: subscription.cancel_at_period_end,
        payment_source: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.payment_source} ELSE 'stripe' END`,
        plan: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.plan} ELSE ${plan} END`,
        status: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.status} ELSE ${status} END`,
        current_period_start: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.current_period_start} ELSE ${periods.current_period_start}::timestamptz END`,
        current_period_end: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.current_period_end} ELSE ${periods.current_period_end}::timestamptz END`,
        credit_renewal_at: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.credit_renewal_at} ELSE NULL END`,
        commit_ends_at: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.commit_ends_at} ELSE ${commitEndsAt}::timestamptz END`,
        past_due_since: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.past_due_since} ELSE NULL END`,
        suspended_at: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.suspended_at} ELSE NULL END`,
        destruction_deadline: sql`CASE WHEN ${kiloclaw_subscriptions.payment_source} = 'credits' AND ${kiloclaw_subscriptions.stripe_subscription_id} IS NOT NULL THEN ${kiloclaw_subscriptions.destruction_deadline} ELSE NULL END`,
      })
      .where(eq(kiloclaw_subscriptions.id, existingRow.id))
      .returning();

    await insertStripeSubscriptionChangeLog(tx, {
      subscriptionId: afterSubscription?.id ?? beforeSubscription?.id ?? '',
      action: beforeSubscription ? 'status_changed' : 'created',
      reason: 'stripe_subscription_created',
      before: beforeSubscription ?? null,
      after: afterSubscription ?? null,
    });

    beforeSubscriptionForMarkerClear = beforeSubscription ?? null;
    afterSubscriptionForMarkerClear = afterSubscription ?? null;
    didProcess = true;
  });

  await clearTrialInactivityStopAfterStripeTrialTransition({
    userId: kiloUserId,
    before: beforeSubscriptionForMarkerClear,
    after: afterSubscriptionForMarkerClear,
  });

  if (wasSuspended) {
    await autoResumeIfSuspended(kiloUserId, resolvedInstanceId);
  }

  if (didProcess) {
    await ensureAutoIntroSchedule(subscription.id, kiloUserId);
  }

  if (didProcess && convertedFromTrial) {
    await runAfterResponse(async () => {
      try {
        await enqueueAffiliateEventForUser({
          userId: kiloUserId,
          provider: 'impact',
          eventType: 'trial_end',
          dedupeKey: buildAffiliateEventDedupeKey({
            provider: 'impact',
            eventType: 'trial_end',
            entityId: subscription.id,
          }),
          eventDate: trialEndEventDate,
          orderId: IMPACT_ORDER_ID_MACRO,
        });
      } catch (error) {
        logWarning('Affiliate trial end enqueue failed', {
          stripe_event_id: eventId,
          user_id: kiloUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  logInfo('KiloClaw subscription.created processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
    plan,
  });
}

/**
 * Handle customer.subscription.updated for KiloClaw subscriptions.
 */
export async function handleKiloClawSubscriptionUpdated(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.updated missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const { kiloUserId } = metadata;
  const plan = detectPlanFromSubscription(subscription, metadata.plan);
  const periods = getSubscriptionPeriods(subscription, kiloUserId);
  const status = mapStripeStatus(subscription.status);

  // Pre-read to detect hybrid state and suspension for auto-resume
  const [preRead] = await db
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      instance_id: kiloclaw_subscriptions.instance_id,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      payment_source: kiloclaw_subscriptions.payment_source,
      stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id))
    .limit(1);

  if (!preRead) {
    logWarning('KiloClaw subscription.updated: no matching row found', {
      stripe_event_id: eventId,
      user_id: kiloUserId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const isHybrid = preRead.payment_source === 'credits' && preRead.stripe_subscription_id !== null;

  if (isHybrid) {
    // Hybrid guard: only propagate cancel intent and dunning states.
    // Do NOT overwrite plan, period fields, commit_ends_at, payment_source.
    // Do NOT clear suspended_at/destruction_deadline or trigger auto-resume.
    // Dunning = payment-failure statuses only. Do NOT include 'canceled' here:
    // when Stripe reports canceled for a hybrid row, the standalone-to-credit
    // conversion handler manages the transition (see spec Standalone-to-Credit
    // Conversion rule 4). Propagating canceled here would prematurely terminate
    // the hybrid row before conversion can run.
    const isDunningStatus = status === 'past_due' || status === 'unpaid';

    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .limit(1);
    const [after] = await db
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: subscription.cancel_at_period_end,
        // Only propagate dunning statuses; do NOT update to active
        ...(isDunningStatus ? { status } : {}),
        // Record past_due_since for dunning states; preserve existing for non-dunning
        ...(status === 'past_due'
          ? { past_due_since: sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, now())` }
          : {}),
      })
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .returning();
    await insertStripeSubscriptionChangeLog(db, {
      subscriptionId: after?.id ?? before?.id,
      action: 'status_changed',
      reason: 'stripe_subscription_updated_hybrid',
      before: before ?? null,
      after: after ?? null,
      bestEffort: true,
    });
    logInfo('KiloClaw subscription.updated processed (hybrid path)', {
      stripe_event_id: eventId,
      user_id: preRead.user_id,
      status,
      cancel_at_period_end: subscription.cancel_at_period_end,
      propagated_dunning: status === 'past_due' || status === 'unpaid',
    });
    // No auto-resume for hybrid rows — recovery is owned by invoice settlement
    return;
  } else {
    // Non-hybrid: keep existing behavior unchanged
    const wasSuspended = status === 'active' && !!preRead.suspended_at;

    // Guard on stripe_subscription_id so stale webhooks for a superseded
    // subscription don't overwrite the replacement subscription's data.
    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .limit(1);
    const [after] = await db
      .update(kiloclaw_subscriptions)
      .set({
        status,
        plan,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_start: periods.current_period_start,
        current_period_end: periods.current_period_end,
        // Commit plan auto-renewal: when the existing commit_ends_at boundary
        // has passed, advance it forward in 6-month increments until it is in
        // the future. This fires naturally on renewal webhooks
        // (subscription.updated events), keeping the subscription on the
        // commit price indefinitely in 6-month windows.
        // If commit_ends_at is null (e.g. update webhook arrived before the
        // creation handler persisted it), fall back to current_period_start
        // + 6 months to approximate the correct 6-month commit boundary.
        // When leaving commit, clear it.
        ...(plan !== 'commit'
          ? { commit_ends_at: null }
          : {
              commit_ends_at: sql`CASE
                WHEN ${kiloclaw_subscriptions.commit_ends_at} IS NOT NULL
                     AND ${kiloclaw_subscriptions.commit_ends_at} < now()
                THEN ${kiloclaw_subscriptions.commit_ends_at} + interval '6 months'
                     * CEIL(EXTRACT(EPOCH FROM (now() - ${kiloclaw_subscriptions.commit_ends_at}))
                            / EXTRACT(EPOCH FROM interval '6 months'))
                ELSE COALESCE(
                  ${kiloclaw_subscriptions.commit_ends_at},
                  ${periods.current_period_start}::timestamptz + interval '6 months'
                )
              END`,
            }),
        // Record when the subscription first entered past_due; clear when recovered.
        // past_due_since drives the 14-day grace period in the billing lifecycle cron
        // (updated_at would be unreliable because $onUpdateFn refreshes it on every write).
        past_due_since:
          status === 'past_due'
            ? sql`COALESCE(${kiloclaw_subscriptions.past_due_since}, now())`
            : null,
        ...(status === 'active' ? { suspended_at: null, destruction_deadline: null } : {}),
      })
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .returning();

    await insertStripeSubscriptionChangeLog(db, {
      subscriptionId: after?.id ?? before?.id,
      action: 'status_changed',
      reason: 'stripe_subscription_updated',
      before: before ?? null,
      after: after ?? null,
      bestEffort: true,
    });

    await clearTrialInactivityStopAfterStripeTrialTransition({
      userId: preRead.user_id,
      before: before ?? null,
      after: after ?? null,
    });

    if (wasSuspended) {
      await autoResumeIfSuspended(preRead.user_id, preRead.instance_id ?? undefined);
    }
  }

  logInfo('KiloClaw subscription.updated processed', {
    stripe_event_id: eventId,
    user_id: preRead.user_id,
    status,
    plan,
  });
}

/**
 * Handle customer.subscription.deleted for KiloClaw subscriptions.
 * Sets status to canceled. The billing lifecycle cron handles graceful shutdown.
 */
export async function handleKiloClawSubscriptionDeleted(params: {
  eventId: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, subscription } = params;
  const metadata = getKiloClawMetadata(subscription.metadata);

  if (!metadata) {
    logWarning('KiloClaw subscription.deleted missing metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  const { kiloUserId } = metadata;

  // Pre-read the row so we can detect conversion flag and hybrid state.
  const [preRead] = await db
    .select({
      id: kiloclaw_subscriptions.id,
      user_id: kiloclaw_subscriptions.user_id,
      payment_source: kiloclaw_subscriptions.payment_source,
      current_period_end: kiloclaw_subscriptions.current_period_end,
      pending_conversion: kiloclaw_subscriptions.pending_conversion,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id))
    .limit(1);

  if (!preRead) {
    logWarning('KiloClaw subscription.deleted: no matching row found', {
      stripe_event_id: eventId,
      user_id: kiloUserId,
      stripe_subscription_id: subscription.id,
    });
    return;
  }

  // Only convert to pure credit when the user explicitly accepted conversion
  // (pending_conversion flag set by acceptConversion). Checking Kilo Pass alone
  // is insufficient — subscription.deleted also fires for dunning/suspended rows
  // that Stripe auto-cancels, and restoring active status there would grant a
  // free grace window. See Standalone-to-Credit Conversion rule 4.
  if (preRead.pending_conversion) {
    // Conversion path: clear Stripe subscription ID, set payment_source to
    // credits, and set credit_renewal_at to the existing period end so the
    // credit renewal sweep picks up the next renewal.
    // Restore status to 'active' because subscription.updated may have already
    // propagated 'canceled' for non-hybrid rows before this event fires.
    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .limit(1);
    const [after] = await db
      .update(kiloclaw_subscriptions)
      .set({
        status: 'active',
        stripe_subscription_id: null,
        payment_source: 'credits',
        credit_renewal_at: preRead.current_period_end,
        cancel_at_period_end: false,
        pending_conversion: false,
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
      })
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .returning();

    await insertStripeSubscriptionChangeLog(db, {
      subscriptionId: after?.id ?? before?.id,
      action: 'payment_source_changed',
      reason: 'stripe_subscription_deleted_convert_to_credits',
      before: before ?? null,
      after: after ?? null,
      bestEffort: true,
    });

    await clearTrialInactivityStopAfterStripeTrialTransition({
      userId: preRead.user_id,
      before: before ?? null,
      after: after ?? null,
    });

    logInfo('KiloClaw subscription.deleted: converted to pure credit', {
      stripe_event_id: eventId,
      user_id: preRead.user_id,
      credit_renewal_at: preRead.current_period_end,
    });
  } else {
    // Standard cancellation path
    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .limit(1);
    const [after] = await db
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
      })
      .where(eq(kiloclaw_subscriptions.id, preRead.id))
      .returning();

    await insertStripeSubscriptionChangeLog(db, {
      subscriptionId: after?.id ?? before?.id,
      action: 'canceled',
      reason: 'stripe_subscription_deleted',
      before: before ?? null,
      after: after ?? null,
      bestEffort: true,
    });

    await clearTrialInactivityStopAfterStripeTrialTransition({
      userId: preRead.user_id,
      before: before ?? null,
      after: after ?? null,
    });

    logInfo('KiloClaw subscription.deleted processed', {
      stripe_event_id: eventId,
      user_id: preRead.user_id,
    });
  }
}

/**
 * Handle subscription_schedule.updated for KiloClaw subscriptions.
 * On completed: apply the scheduled plan transition.
 * On released/canceled: clear schedule tracking fields without changing plan.
 */
export async function handleKiloClawScheduleEvent(params: {
  eventId: string;
  schedule: Stripe.SubscriptionSchedule;
}): Promise<void> {
  const { eventId, schedule } = params;
  const scheduleId = schedule.id;
  const scheduleStatus = schedule.status;

  // Find the row that references this schedule
  const [row] = await db
    .select({
      user_id: kiloclaw_subscriptions.user_id,
      plan: kiloclaw_subscriptions.plan,
      scheduled_plan: kiloclaw_subscriptions.scheduled_plan,
      payment_source: kiloclaw_subscriptions.payment_source,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId))
    .limit(1);

  if (!row) {
    // Not a KiloClaw schedule — return silently so the kilo-pass handler can try
    return;
  }

  if (
    scheduleStatus === 'released' ||
    scheduleStatus === 'canceled' ||
    scheduleStatus === 'completed'
  ) {
    const [before] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId))
      .limit(1);
    const updateSet: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {
      stripe_schedule_id: null,
      scheduled_plan: null,
      scheduled_by: null,
    };

    // Apply the scheduled plan only on 'completed' for non-hybrid rows.
    // Hybrid rows: plan mutation is owned by invoice settlement (Hybrid
    // Subscription Ownership rule 4). Only clear schedule tracking fields.
    // Our schedules use end_behavior: 'release', so natural transitions
    // fire as 'released' — but so do intentional cancels (cancelSubscription,
    // cancelPlanSwitch). Since subscription.updated already picks up the new
    // price via detectPlanFromSubscription, we don't need to apply the plan
    // here for 'released'. Restricting to 'completed' eliminates the race
    // where a cancel-release webhook arrives before the local DB clears the
    // schedule.
    if (scheduleStatus === 'completed' && row.scheduled_plan && row.payment_source !== 'credits') {
      updateSet.plan = row.scheduled_plan;
      if (row.scheduled_plan === 'standard') {
        updateSet.commit_ends_at = null;
      } else if (row.scheduled_plan === 'commit') {
        // Standard → Commit switch released. Derive the first commit
        // boundary from the Stripe-resolved last phase start_date (the
        // exact transition moment) + 6 calendar months.
        const lastPhase = schedule.phases[schedule.phases.length - 1];
        const transitionDate = lastPhase ? new Date(lastPhase.start_date * 1000) : new Date();
        updateSet.commit_ends_at = addMonths(transitionDate, 6).toISOString();
      }
    }

    const [after] = await db
      .update(kiloclaw_subscriptions)
      .set(updateSet)
      .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId))
      .returning();

    await insertStripeSubscriptionChangeLog(db, {
      subscriptionId: after?.id ?? before?.id,
      action:
        scheduleStatus === 'completed' && !!updateSet.plan ? 'plan_switched' : 'schedule_changed',
      reason: `stripe_schedule_${scheduleStatus}`,
      before: before ?? null,
      after: after ?? null,
      bestEffort: true,
    });
  }

  logInfo('KiloClaw schedule event processed', {
    stripe_event_id: eventId,
    schedule_id: scheduleId,
    schedule_status: scheduleStatus,
    user_id: row.user_id,
  });
}

/**
 * Handle invoice.paid events for KiloClaw subscriptions.
 *
 * Extracts required fields from the invoice, resolves the user from subscription
 * metadata, delegates to the credit settlement flow, and fires a PostHog
 * claw_transaction event for revenue tracking.
 */
export async function handleKiloClawInvoicePaid(params: {
  eventId: string;
  invoice: Stripe.Invoice;
}): Promise<void> {
  const { eventId, invoice } = params;

  // Stripe can emit paid $0 invoices with no charge. Use charge ID when present,
  // otherwise fall back to invoice ID so settlement still runs idempotently.
  const chargeId =
    'charge' in invoice && typeof invoice.charge === 'string' ? invoice.charge : null;
  const stripePaymentId = chargeId ?? invoice.id;

  // Resolve stripeSubscriptionId from parent subscription details
  const rawSubscription = invoice.parent?.subscription_details?.subscription;
  const stripeSubscriptionId =
    rawSubscription === null || rawSubscription === undefined
      ? null
      : typeof rawSubscription === 'string'
        ? rawSubscription
        : rawSubscription.id;

  if (!stripeSubscriptionId) {
    logWarning('KiloClaw invoice.paid missing subscription', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
      has_subscription: !!stripeSubscriptionId,
    });
    return;
  }

  // Find the KiloClaw line item by matching price against known price IDs
  let knownPriceIds: readonly string[];
  try {
    knownPriceIds = getKnownStripePriceIdsForKiloClaw();
  } catch {
    logWarning('KiloClaw price IDs not configured, skipping invoice', {
      stripe_event_id: eventId,
    });
    return;
  }
  const knownIdSet = new Set(knownPriceIds);

  const lines = invoice.lines?.data ?? [];
  const matchingLine = lines.find(line => {
    const priceId = line.pricing?.price_details?.price ?? null;
    return priceId !== null && knownIdSet.has(priceId);
  });

  if (!matchingLine) {
    logWarning('KiloClaw invoice.paid has no matching line item', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
    });
    return;
  }

  const matchingPriceId = matchingLine.pricing?.price_details?.price ?? null;
  const periodStartUnix = matchingLine.period?.start;
  const periodEndUnix = matchingLine.period?.end;

  if (!matchingPriceId || !periodStartUnix || !periodEndUnix) {
    logWarning('KiloClaw invoice.paid line item missing price or period', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
      has_price: !!matchingPriceId,
      has_period_start: !!periodStartUnix,
      has_period_end: !!periodEndUnix,
    });
    return;
  }

  // Determine plan from the matching price ID
  const plan = getClawPlanForStripePriceId(matchingPriceId);
  if (!plan) {
    logWarning('KiloClaw invoice.paid price ID does not map to a plan', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
      price_id: matchingPriceId,
    });
    return;
  }

  // Resolve user ID from subscription metadata.
  // We must fetch the subscription from Stripe to read metadata.
  let stripeSubscription: Stripe.Subscription;
  try {
    stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  } catch (error) {
    logWarning('Failed to retrieve Stripe subscription for invoice settlement', {
      stripe_event_id: eventId,
      stripe_subscription_id: stripeSubscriptionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const metadata = getKiloClawMetadata(stripeSubscription.metadata);
  if (!metadata) {
    logWarning('KiloClaw invoice.paid subscription has no KiloClaw metadata', {
      stripe_event_id: eventId,
      stripe_subscription_id: stripeSubscriptionId,
    });
    return;
  }

  const periodStart = new Date(periodStartUnix * 1000).toISOString();
  const periodEnd = new Date(periodEndUnix * 1000).toISOString();
  const amountMicrodollars = invoice.amount_paid * 10_000;

  const applied = await applyStripeFundedKiloClawPeriod({
    userId: metadata.kiloUserId,
    metadataInstanceId: metadata.instanceId ?? undefined,
    stripeSubscriptionId,
    stripePaymentId,
    plan,
    amountMicrodollars,
    periodStart,
    periodEnd,
  });

  if (!applied) {
    logQuarantinedStripeEvent('invoice_paid_unresolved_target', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: stripeSubscriptionId,
      user_id: metadata.kiloUserId,
      metadata_instance_id: metadata.instanceId,
    });
    return;
  }

  logInfo('KiloClaw invoice.paid processed', {
    stripe_event_id: eventId,
    user_id: metadata.kiloUserId,
    plan,
    stripe_subscription_id: stripeSubscriptionId,
    amount_paid: invoice.amount_paid,
  });

  if (invoice.amount_paid > 0 && chargeId) {
    try {
      const eventDate =
        invoice.status_transitions?.paid_at != null
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : new Date();
      await enqueueAffiliateEventForUser({
        userId: metadata.kiloUserId,
        provider: 'impact',
        eventType: 'sale',
        dedupeKey: buildAffiliateEventDedupeKey({
          provider: 'impact',
          eventType: 'sale',
          entityId: invoice.id,
        }),
        orderId: invoice.id,
        amount: invoice.amount_paid / 100,
        currencyCode: invoice.currency ?? 'usd',
        eventDate,
        itemCategory: getImpactItemCategory(plan),
        itemName: getImpactItemName(plan),
        itemSku: matchingPriceId,
        stripeChargeId: chargeId,
      });
    } catch (error) {
      logWarning('Affiliate sale enqueue failed', {
        stripe_event_id: eventId,
        user_id: metadata.kiloUserId,
        stripe_charge_id: chargeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fire PostHog revenue tracking event in the background
  if (!IS_IN_AUTOMATED_TEST && invoice.amount_paid > 0) {
    await runAfterResponse(async () => {
      const [user] = await db
        .select({ email: kilocode_users.google_user_email })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, metadata.kiloUserId))
        .limit(1);

      if (!user) {
        logWarning('KiloClaw invoice.paid user not found for PostHog tracking', {
          stripe_event_id: eventId,
          kilo_user_id: metadata.kiloUserId,
        });
        return;
      }

      PostHogClient().capture({
        distinctId: user.email,
        event: 'claw_transaction',
        properties: {
          user_id: metadata.kiloUserId,
          plan,
          amount_cents: invoice.amount_paid,
          currency: invoice.currency,
          stripe_invoice_id: invoice.id,
          stripe_subscription_id: stripeSubscriptionId,
        },
      });
    });
  }
}
