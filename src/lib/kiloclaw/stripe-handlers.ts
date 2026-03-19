import 'server-only';

import type Stripe from 'stripe';
import { eq, and, sql } from 'drizzle-orm';
import { addMonths } from 'date-fns';

import { db } from '@/lib/drizzle';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import { getClawPlanForStripePriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import { sentryLogger } from '@/lib/utils.server';
import { autoResumeIfSuspended } from '@/lib/kiloclaw/credit-billing';

const logInfo = sentryLogger('kiloclaw-stripe', 'info');
const logWarning = sentryLogger('kiloclaw-stripe', 'warning');

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
 * Only called for paid plans (commit/standard). Subscriptions created with
 * trial_end (delayed billing) arrive as 'trialing' — treat as active.
 */
function mapStripeStatus(stripeStatus: string): KiloClawSubscriptionStatus {
  if (stripeStatus === 'trialing') return 'active';
  return STRIPE_TO_CLAW_STATUS[stripeStatus] ?? 'active';
}

/**
 * Handle customer.subscription.created for KiloClaw subscriptions.
 *
 * Stripe propagates subscription_data.metadata from the checkout session
 * to the subscription object, so we can read kiloUserId and plan from metadata.
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

  // Capture suspension state before the upsert clears it, so auto-resume
  // can fire for re-subscribing users who were previously suspended.
  let wasSuspended = false;

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

    // Set wasSuspended only after passing the stale guard — stale events
    // must not trigger auto-resume for the current subscription.
    wasSuspended = !!existingRow?.suspended_at;

    // For commit plans, derive commit_ends_at. If the subscription has a
    // delayed-billing trial_end, the 6-month commit term starts after the
    // trial boundary, not at subscription creation time.
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
        payment_source: 'stripe',
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
          payment_source: 'stripe',
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
  });

  // Auto-resume: if user was suspended before this re-subscription, start their
  // instance and clear suspension cycle emails. wasSuspended was captured inside
  // the transaction before the upsert cleared suspended_at.
  if (wasSuspended) {
    await autoResumeIfSuspended(kiloUserId);
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
      payment_source: 'stripe',
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
 * Schedules are only created by user-initiated plan switches.
 * When a schedule completes: apply the scheduled plan transition.
 * When released/canceled: clear schedule tracking fields without changing plan.
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
