import 'server-only';

import type Stripe from 'stripe';
import { eq, and, isNotNull, isNull, sql } from 'drizzle-orm';
import { addMonths } from 'date-fns';

import { db } from '@/lib/drizzle';
import { kiloclaw_subscriptions, kiloclaw_instances, kilocode_users } from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  getClawPlanForStripePriceId,
  getKnownStripePriceIdsForKiloClaw,
  getStripePriceIdForClawPlan,
  isIntroPriceId,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import { applyStripeFundedKiloClawPeriod } from '@/lib/kiloclaw/credit-billing';
import { autoResumeIfSuspended } from '@/lib/kiloclaw/instance-lifecycle';
import { sentryLogger } from '@/lib/utils.server';
import PostHogClient from '@/lib/posthog';
import { after } from 'next/server';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { client as stripe } from '@/lib/stripe-client';
import { getAffiliateAttribution } from '@/lib/affiliate-attribution';
import { trackSale, trackTrialEnd } from '@/lib/impact';

const logInfo = sentryLogger('kiloclaw-stripe', 'info');
const logWarning = sentryLogger('kiloclaw-stripe', 'warning');
const logError = sentryLogger('kiloclaw-stripe', 'error');

type KiloClawSubscriptionMetadata = {
  type: 'kiloclaw';
  plan: 'commit' | 'standard';
  kiloUserId: string;
  impactClickId?: string;
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
    impactClickId: metadata.impactClickId || undefined,
  };
}

async function getImpactTrackingContext(userId: string, fallbackClickId?: string) {
  const [user, attribution] = await Promise.all([
    db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, userId),
      columns: { google_user_email: true },
    }),
    getAffiliateAttribution(userId, 'impact'),
  ]);

  if (!user) return null;

  return {
    customerEmail: user.google_user_email,
    clickId: attribution?.tracking_id ?? fallbackClickId ?? null,
  };
}

function getImpactItemCategory(plan: 'commit' | 'standard') {
  return `kiloclaw-${plan}`;
}

function getImpactItemName(plan: 'commit' | 'standard') {
  return plan === 'commit' ? 'KiloClaw Commit Plan' : 'KiloClaw Standard Plan';
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

async function persistAutoIntroSchedule(scheduleId: string, userId: string): Promise<void> {
  await db
    .update(kiloclaw_subscriptions)
    .set({
      stripe_schedule_id: scheduleId,
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    })
    .where(eq(kiloclaw_subscriptions.user_id, userId));
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
  stripeSubscriptionId: string,
  userId: string
): Promise<boolean> {
  // If the user has repurposed this schedule via switchPlan (scheduled_by = 'user'),
  // do not overwrite their pending plan switch. switchPlan reuses the auto-intro
  // schedule but doesn't change metadata.origin, so it still reads as 'auto-intro'.
  const [dbRow] = await db
    .select({ scheduled_by: kiloclaw_subscriptions.scheduled_by })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);

  if (dbRow?.scheduled_by === 'user') {
    return true;
  }

  const regularPriceId = getStripePriceIdForClawPlan('standard');
  const phase2Price = schedule.phases[1] ? resolvePhasePrice(schedule.phases[1]) : null;

  if (schedule.phases.length >= 2 && phase2Price === regularPriceId) {
    await persistAutoIntroSchedule(schedule.id, userId);
    return true;
  }

  // Half-configured: rewrite to add the regular-price phase
  const existingPhase = schedule.phases[0];
  const existingPhasePrice = existingPhase ? resolvePhasePrice(existingPhase) : null;
  if (!existingPhase || !existingPhasePrice) {
    logError('Half-configured auto-intro schedule has no usable phase', {
      stripe_subscription_id: stripeSubscriptionId,
      schedule_id: schedule.id,
      user_id: userId,
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
  await persistAutoIntroSchedule(schedule.id, userId);
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
  userId: string
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
      const valid = await validateOrRepairAutoIntroSchedule(schedule, stripeSubscriptionId, userId);
      if (!valid) {
        logError('Auto-intro schedule is unrecoverable, skipping', {
          stripe_subscription_id: stripeSubscriptionId,
          schedule_id: schedule.id,
          user_id: userId,
        });
      }
      return;
    }

    logWarning('Subscription has non-auto-intro schedule attached, skipping auto schedule', {
      stripe_subscription_id: stripeSubscriptionId,
      user_id: userId,
      schedule_id: schedule.id,
    });
    return;
  }

  // Clear stale schedule pointer if Stripe says no schedule
  const [existingRow] = await db
    .select({ stripe_schedule_id: kiloclaw_subscriptions.stripe_schedule_id })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);

  if (existingRow?.stripe_schedule_id) {
    await db
      .update(kiloclaw_subscriptions)
      .set({ stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null })
      .where(eq(kiloclaw_subscriptions.user_id, userId));
  }

  await createAutoIntroSchedule(stripeSubscriptionId, userId);
}

/**
 * Create a new 2-phase auto-intro schedule (intro → regular standard) for a
 * subscription. Handles the race where a concurrent caller attaches a schedule
 * between our check and the create call.
 */
async function createAutoIntroSchedule(
  stripeSubscriptionId: string,
  userId: string
): Promise<void> {
  let newSchedule: Stripe.SubscriptionSchedule;
  try {
    newSchedule = await stripe.subscriptionSchedules.create({
      from_subscription: stripeSubscriptionId,
    });
  } catch (error) {
    await handleAutoIntroCreateRace(error, stripeSubscriptionId, userId);
    return;
  }

  const currentPhase = newSchedule.phases[0];
  const phase1Price = currentPhase ? resolvePhasePrice(currentPhase) : null;
  if (!currentPhase || !phase1Price) {
    logError('Auto-intro schedule created with unusable phase', {
      stripe_subscription_id: stripeSubscriptionId,
      schedule_id: newSchedule.id,
      user_id: userId,
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

  await persistAutoIntroSchedule(newSchedule.id, userId);
}

/**
 * Handle a failed subscriptionSchedules.create call during auto-intro setup.
 * If the failure was a race (another caller attached a schedule concurrently),
 * validate/repair the winning schedule. Otherwise re-throw.
 */
async function handleAutoIntroCreateRace(
  error: unknown,
  stripeSubscriptionId: string,
  userId: string
): Promise<void> {
  const refetched = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const refetchedScheduleId = resolveScheduleId(refetched.schedule);
  if (!refetchedScheduleId) {
    logError('Failed to create auto-intro schedule (non-race error)', {
      stripe_subscription_id: stripeSubscriptionId,
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logWarning('Race creating auto-intro schedule, re-checking subscription', {
    stripe_subscription_id: stripeSubscriptionId,
    user_id: userId,
    error: error instanceof Error ? error.message : String(error),
  });

  const existingSchedule = await stripe.subscriptionSchedules.retrieve(refetchedScheduleId);

  if (await claimIfAutoIntro(existingSchedule)) {
    const valid = await validateOrRepairAutoIntroSchedule(
      existingSchedule,
      stripeSubscriptionId,
      userId
    );
    if (!valid) {
      logError('Race-recovered auto-intro schedule is unrecoverable', {
        stripe_subscription_id: stripeSubscriptionId,
        schedule_id: existingSchedule.id,
        user_id: userId,
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

  const { kiloUserId } = metadata;
  const plan = detectPlanFromSubscription(subscription, metadata.plan);
  const periods = getSubscriptionPeriods(subscription, kiloUserId);
  const status = mapStripeStatus(subscription.status);

  let wasSuspended = false;
  let didProcess = false;
  let resolvedInstanceId: string | undefined;
  let convertedFromTrial = false;

  await db.transaction(async tx => {
    // Look up the user's active instance to link the subscription.
    const [activeInstance] = await tx
      .select({ id: kiloclaw_instances.id })
      .from(kiloclaw_instances)
      .where(
        and(eq(kiloclaw_instances.user_id, kiloUserId), isNull(kiloclaw_instances.destroyed_at))
      )
      .limit(1);

    // Guard against stale subscription.created retries: if the instance already
    // has a row referencing a different Stripe subscription, this event is
    // outdated and must not overwrite the newer subscription's data.
    // Exception: if the existing row is canceled, this is a legitimate
    // re-subscription (createSubscriptionCheckout allows canceled users to
    // buy again), so we let the upsert proceed.
    const existingRow = activeInstance
      ? (
          await tx
            .select({
              stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
              status: kiloclaw_subscriptions.status,
              suspended_at: kiloclaw_subscriptions.suspended_at,
            })
            .from(kiloclaw_subscriptions)
            .where(eq(kiloclaw_subscriptions.instance_id, activeInstance.id))
            .limit(1)
        )[0]
      : undefined;

    if (
      existingRow &&
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
        }
      );
      return;
    }

    // Captured after the stale guard so stale events don't auto-resume
    wasSuspended = !!existingRow?.suspended_at;
    convertedFromTrial = existingRow?.status === 'trialing';
    resolvedInstanceId = activeInstance?.id;

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

    // Clean up orphaned rows: if a prior delivery inserted a row with
    // instance_id = NULL (no active instance at the time), delete it so
    // the upsert below can link the subscription to the now-available
    // instance without hitting the unique stripe_subscription_id constraint.
    // We delete rather than update-in-place because the instance may
    // already have its own row (e.g. trial), and reattaching would collide
    // with UQ_kiloclaw_subscriptions_instance.
    if (resolvedInstanceId) {
      await tx
        .delete(kiloclaw_subscriptions)
        .where(
          and(
            eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id),
            isNull(kiloclaw_subscriptions.instance_id)
          )
        );
    }

    // Upsert: if trial/canceled row exists for this instance, upgrade it; otherwise insert.
    // Always use the freshly computed commitEndsAt — the stale-subscription
    // guard above already rejects replays for superseded subscriptions, so
    // on conflict the incoming subscription is either identical (safe to
    // overwrite with the same value) or a legitimate re-subscription after
    // cancellation (must not inherit the old commit boundary).
    //
    // Conflict target is instance_id (the per-instance unique index) so a
    // second Stripe subscription for the same user creates a separate row
    // for each instance instead of overwriting a single user-scoped row.
    if (resolvedInstanceId) {
      await tx
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: kiloUserId,
          instance_id: resolvedInstanceId,
          stripe_subscription_id: subscription.id,
          plan,
          status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_start: periods.current_period_start,
          current_period_end: periods.current_period_end,
          commit_ends_at: commitEndsAt,
        })
        .onConflictDoUpdate({
          target: kiloclaw_subscriptions.instance_id,
          targetWhere: isNotNull(kiloclaw_subscriptions.instance_id),
          set: {
            // Always update regardless of payment_source
            stripe_subscription_id: subscription.id,
            cancel_at_period_end: subscription.cancel_at_period_end,
            // Hybrid guard: when existing row is hybrid (payment_source = 'credits'
            // AND has a stripe_subscription_id), preserve billing fields owned by
            // invoice settlement (Hybrid Subscription Ownership rule 3).
            // Non-hybrid rows (pure credit with null stripe_subscription_id, or
            // legacy/null payment_source) get reset to fresh Stripe state. The
            // ELSE branches must NOT preserve stale values — a canceled pure-credit
            // row resubscribing via Stripe must reset payment_source to 'stripe'
            // and clear credit_renewal_at to avoid looking hybrid before settlement.
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
          },
        });
    } else {
      // No active instance — edge case where user destroyed their instance
      // between checkout and webhook delivery. Use ON CONFLICT on
      // stripe_subscription_id so Stripe webhook retries are idempotent.
      await tx
        .insert(kiloclaw_subscriptions)
        .values({
          user_id: kiloUserId,
          instance_id: null,
          stripe_subscription_id: subscription.id,
          plan,
          status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_start: periods.current_period_start,
          current_period_end: periods.current_period_end,
          commit_ends_at: commitEndsAt,
        })
        .onConflictDoNothing({ target: kiloclaw_subscriptions.stripe_subscription_id });
    }

    didProcess = true;
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
        const tracking = await getImpactTrackingContext(kiloUserId, metadata.impactClickId);
        if (!tracking) {
          logWarning('KiloClaw trial conversion missing user for Impact trial end', {
            stripe_event_id: eventId,
            user_id: kiloUserId,
          });
          return;
        }

        await trackTrialEnd({
          clickId: tracking.clickId,
          customerId: kiloUserId,
          customerEmail: tracking.customerEmail,
          eventDate: new Date(),
        });
      } catch (error) {
        logWarning('Impact trial end tracking failed', {
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
      instance_id: kiloclaw_subscriptions.instance_id,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      payment_source: kiloclaw_subscriptions.payment_source,
      stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
      )
    )
    .limit(1);

  const isHybrid = preRead?.payment_source === 'credits' && preRead.stripe_subscription_id !== null;

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

    await db
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
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, kiloUserId),
          eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
        )
      );
    logInfo('KiloClaw subscription.updated processed (hybrid path)', {
      stripe_event_id: eventId,
      user_id: kiloUserId,
      status,
      cancel_at_period_end: subscription.cancel_at_period_end,
      propagated_dunning: status === 'past_due' || status === 'unpaid',
    });
    // No auto-resume for hybrid rows — recovery is owned by invoice settlement
    return;
  } else {
    // Non-hybrid: keep existing behavior unchanged
    const wasSuspended = status === 'active' && !!preRead?.suspended_at;

    // Guard on stripe_subscription_id so stale webhooks for a superseded
    // subscription don't overwrite the replacement subscription's data.
    await db
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
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, kiloUserId),
          eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
        )
      );

    if (wasSuspended) {
      await autoResumeIfSuspended(kiloUserId, preRead?.instance_id ?? undefined);
    }
  }

  logInfo('KiloClaw subscription.updated processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
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
      payment_source: kiloclaw_subscriptions.payment_source,
      current_period_end: kiloclaw_subscriptions.current_period_end,
      pending_conversion: kiloclaw_subscriptions.pending_conversion,
    })
    .from(kiloclaw_subscriptions)
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
      )
    )
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
    await db
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
      .where(eq(kiloclaw_subscriptions.id, preRead.id));

    logInfo('KiloClaw subscription.deleted: converted to pure credit', {
      stripe_event_id: eventId,
      user_id: kiloUserId,
      credit_renewal_at: preRead.current_period_end,
    });
  } else {
    // Standard cancellation path
    await db
      .update(kiloclaw_subscriptions)
      .set({
        status: 'canceled',
        cancel_at_period_end: false,
        scheduled_plan: null,
        scheduled_by: null,
        stripe_schedule_id: null,
      })
      .where(eq(kiloclaw_subscriptions.id, preRead.id));

    logInfo('KiloClaw subscription.deleted processed', {
      stripe_event_id: eventId,
      user_id: kiloUserId,
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

    await db
      .update(kiloclaw_subscriptions)
      .set(updateSet)
      .where(eq(kiloclaw_subscriptions.stripe_schedule_id, scheduleId));
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

  // Resolve chargeId — the charge field is present at runtime in webhook payloads
  // but removed from newer Stripe type definitions. Use a runtime guard.
  const chargeId =
    'charge' in invoice && typeof invoice.charge === 'string' ? invoice.charge : null;

  // Resolve stripeSubscriptionId from parent subscription details
  const rawSubscription = invoice.parent?.subscription_details?.subscription;
  const stripeSubscriptionId =
    rawSubscription === null || rawSubscription === undefined
      ? null
      : typeof rawSubscription === 'string'
        ? rawSubscription
        : rawSubscription.id;

  if (!chargeId || !stripeSubscriptionId) {
    logWarning('KiloClaw invoice.paid missing charge or subscription', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
      has_charge: !!chargeId,
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

  await applyStripeFundedKiloClawPeriod({
    userId: metadata.kiloUserId,
    stripeSubscriptionId,
    chargeId,
    plan,
    amountMicrodollars,
    periodStart,
    periodEnd,
  });

  logInfo('KiloClaw invoice.paid processed', {
    stripe_event_id: eventId,
    user_id: metadata.kiloUserId,
    plan,
    stripe_subscription_id: stripeSubscriptionId,
    amount_paid: invoice.amount_paid,
  });

  await runAfterResponse(async () => {
    try {
      const tracking = await getImpactTrackingContext(metadata.kiloUserId, metadata.impactClickId);
      if (!tracking) {
        logWarning('KiloClaw invoice.paid user not found for Impact tracking', {
          stripe_event_id: eventId,
          kilo_user_id: metadata.kiloUserId,
        });
        return;
      }

      const eventDate =
        invoice.status_transitions?.paid_at != null
          ? new Date(invoice.status_transitions.paid_at * 1000)
          : new Date();
      const salePayload = {
        clickId: tracking.clickId,
        customerId: metadata.kiloUserId,
        customerEmail: tracking.customerEmail,
        orderId: invoice.id,
        amount: invoice.amount_paid / 100,
        currencyCode: invoice.currency ?? 'usd',
        eventDate,
        itemCategory: getImpactItemCategory(plan),
        itemName: getImpactItemName(plan),
      };

      await trackSale(salePayload);
    } catch (error) {
      logWarning('Impact sale tracking failed', {
        stripe_event_id: eventId,
        user_id: metadata.kiloUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Fire PostHog revenue tracking event in the background
  if (!IS_IN_AUTOMATED_TEST) {
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
