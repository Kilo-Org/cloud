import 'server-only';

import type Stripe from 'stripe';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { addMonths } from 'date-fns';

import { db } from '@/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_email_log,
  kilocode_users,
} from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import {
  getClawPlanForStripePriceId,
  getStripePriceIdForClawPlan,
  isIntroPriceId,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import { sentryLogger } from '@/lib/utils.server';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import PostHogClient from '@/lib/posthog';
import { after } from 'next/server';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import { client as stripe } from '@/lib/stripe-client';

const logInfo = sentryLogger('kiloclaw-stripe', 'info');
const logWarning = sentryLogger('kiloclaw-stripe', 'warning');
const logError = sentryLogger('kiloclaw-stripe', 'error');

type KiloClawSubscriptionMetadata = {
  type: 'kiloclaw';
  plan: 'commit' | 'standard';
  kiloUserId: string;
};

function getKiloClawMetadata(
  metadata: Stripe.Metadata | null | undefined
): KiloClawSubscriptionMetadata | null {
  if (!metadata || metadata.type !== 'kiloclaw') return null;
  const plan = metadata.plan;
  const kiloUserId = metadata.kiloUserId;
  if (!plan || !kiloUserId) return null;
  if (plan !== 'commit' && plan !== 'standard') return null;
  return { type: 'kiloclaw', plan, kiloUserId };
}

function getSubscriptionPeriods(subscription: Stripe.Subscription, kiloUserId?: string) {
  // Stripe moved period timestamps to the item level (not the top-level subscription object).
  const item = subscription.items.data[0];
  if (!item) {
    console.warn(
      '[stripe] Subscription has no items:',
      subscription.id,
      kiloUserId ? `userId=${kiloUserId}` : ''
    );
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

/**
 * If the user was suspended, try to start their instance and clear suspension state.
 */
async function autoResumeIfSuspended(kiloUserId: string): Promise<void> {
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

  // Clear suspension/destruction cycle emails so they can fire again in a future cycle.
  // Trial and earlybird warnings are one-time events and must NOT be cleared.
  const resettableEmailTypes = [
    'claw_suspended_trial',
    'claw_suspended_subscription',
    'claw_suspended_payment',
    'claw_destruction_warning',
    'claw_instance_destroyed',
  ];
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
      )
    );
  // Also clear per-instance ready emails (claw_instance_ready:{sandboxId})
  // so a re-provision after reactivation triggers the notification again.
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, kiloUserId),
        sql`${kiloclaw_email_log.email_type} LIKE 'claw_instance_ready:%'`
      )
    );

  await db
    .update(kiloclaw_subscriptions)
    .set({ suspended_at: null, destruction_deadline: null })
    .where(eq(kiloclaw_subscriptions.user_id, kiloUserId));
}

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

  await db.transaction(async tx => {
    // Guard against stale subscription.created retries: if the user already has
    // a row referencing a different Stripe subscription, this event is outdated
    // and must not overwrite the newer subscription's data.
    // Exception: if the existing row is canceled, this is a legitimate
    // re-subscription (createSubscriptionCheckout allows canceled users to
    // buy again), so we let the upsert proceed.
    const [existingRow] = await tx
      .select({
        stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
        status: kiloclaw_subscriptions.status,
        suspended_at: kiloclaw_subscriptions.suspended_at,
      })
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, kiloUserId))
      .limit(1);

    if (
      existingRow &&
      existingRow.stripe_subscription_id !== null &&
      existingRow.stripe_subscription_id !== subscription.id &&
      existingRow.status !== 'canceled'
    ) {
      logWarning(
        'Ignoring stale subscription.created — user already has a different subscription',
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

    // Upsert: if trial row exists, upgrade it; otherwise insert new row.
    // Always use the freshly computed commitEndsAt — the stale-subscription
    // guard above already rejects replays for superseded subscriptions, so
    // on conflict the incoming subscription is either identical (safe to
    // overwrite with the same value) or a legitimate re-subscription after
    // cancellation (must not inherit the old commit boundary).
    await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: kiloUserId,
        stripe_subscription_id: subscription.id,
        plan,
        status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_start: periods.current_period_start,
        current_period_end: periods.current_period_end,
        commit_ends_at: commitEndsAt,
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.user_id,
        set: {
          stripe_subscription_id: subscription.id,
          plan,
          status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_start: periods.current_period_start,
          current_period_end: periods.current_period_end,
          commit_ends_at: commitEndsAt,
          // Reset delinquency/suspension state from a previous subscription so
          // the new subscription gets a full 14-day grace period on first failure.
          past_due_since: null,
          suspended_at: null,
          destruction_deadline: null,
        },
      });

    didProcess = true;
  });

  if (wasSuspended) {
    await autoResumeIfSuspended(kiloUserId);
  }

  if (didProcess) {
    await ensureAutoIntroSchedule(subscription.id, kiloUserId);
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

  const wasSuspended =
    status === 'active'
      ? await db
          .select({ suspended_at: kiloclaw_subscriptions.suspended_at })
          .from(kiloclaw_subscriptions)
          .where(
            and(
              eq(kiloclaw_subscriptions.user_id, kiloUserId),
              eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
            )
          )
          .limit(1)
          .then(([row]) => !!row?.suspended_at)
      : false;

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
      // the future. This fires naturally on monthly renewal webhooks
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
    await autoResumeIfSuspended(kiloUserId);
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

  // Guard on stripe_subscription_id so a stale delete webhook for a
  // superseded subscription doesn't cancel the replacement subscription.
  await db
    .update(kiloclaw_subscriptions)
    .set({
      status: 'canceled',
      cancel_at_period_end: false,
      scheduled_plan: null,
      scheduled_by: null,
      stripe_schedule_id: null,
    })
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, kiloUserId),
        eq(kiloclaw_subscriptions.stripe_subscription_id, subscription.id)
      )
    );

  logInfo('KiloClaw subscription.deleted processed', {
    stripe_event_id: eventId,
    user_id: kiloUserId,
  });
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

    // Apply the scheduled plan only on 'completed'. Our schedules use
    // end_behavior: 'release', so natural transitions fire as 'released' —
    // but so do intentional cancels (cancelSubscription, cancelPlanSwitch).
    // Since subscription.updated already picks up the new price via
    // detectPlanFromSubscription, we don't need to apply the plan here for
    // 'released'. Restricting to 'completed' eliminates the race where a
    // cancel-release webhook arrives before the local DB clears the schedule.
    if (scheduleStatus === 'completed' && row.scheduled_plan) {
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
 * Handle invoice.paid for KiloClaw subscriptions.
 * Fires a claw_transaction PostHog event for revenue tracking.
 */
export function handleKiloClawInvoicePaid(params: {
  eventId: string;
  invoice: Stripe.Invoice;
}): void {
  const { eventId, invoice } = params;
  const subDetails = invoice.parent?.subscription_details;
  const kiloUserId = subDetails?.metadata?.kiloUserId ?? null;
  const plan = subDetails?.metadata?.plan ?? null;
  const stripeSubscriptionId =
    typeof subDetails?.subscription === 'string' ? subDetails.subscription : null;

  if (!kiloUserId) {
    logWarning('KiloClaw invoice.paid missing kiloUserId in subscription metadata', {
      stripe_event_id: eventId,
      stripe_invoice_id: invoice.id,
    });
    return;
  }

  if (IS_IN_AUTOMATED_TEST) return;

  after(async () => {
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, kiloUserId))
      .limit(1);

    if (!user) {
      logWarning('KiloClaw invoice.paid user not found', {
        stripe_event_id: eventId,
        kilo_user_id: kiloUserId,
      });
      return;
    }

    PostHogClient().capture({
      distinctId: user.email,
      event: 'claw_transaction',
      properties: {
        user_id: kiloUserId,
        plan: plan ?? 'unknown',
        amount_cents: invoice.amount_paid,
        currency: invoice.currency,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: stripeSubscriptionId,
      },
    });
  });
}
