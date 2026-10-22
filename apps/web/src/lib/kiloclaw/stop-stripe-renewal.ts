import 'server-only';

import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { kiloclaw_subscriptions } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { client as stripeClient } from '@kilocode/web-shared/lib/stripe-client';
import { and, eq, isNull } from 'drizzle-orm';

import { createKiloClawAdminAuditLog } from './admin-audit-log';

export type StopKiloClawStripeRenewalActor = {
  id: string;
  email: string;
  name: string | null;
};

export type StopKiloClawStripeRenewalResult = {
  outcome: 'updated' | 'already_canceling' | 'already_canceled';
};

export class KiloClawStripeRenewalReconciliationConflictError extends Error {
  constructor() {
    super(
      'The local KiloClaw subscription could not be reconciled. Stripe renewal may already have been stopped. Review the admin audit log before retrying.'
    );
    this.name = 'KiloClawStripeRenewalReconciliationConflictError';
  }
}

function scheduleId(schedule: string | { id: string } | null): string | null {
  if (!schedule) return null;
  return typeof schedule === 'string' ? schedule : schedule.id;
}

function shouldPreserveScheduledConversion(
  subscription: typeof kiloclaw_subscriptions.$inferSelect
) {
  return (
    subscription.pending_conversion &&
    subscription.plan === 'commit' &&
    subscription.scheduled_plan === 'standard' &&
    subscription.scheduled_by === 'user'
  );
}

function earliestRenewableBoundary(
  liveSubscription: Awaited<ReturnType<typeof stripeClient.subscriptions.retrieve>>
) {
  const boundaries = liveSubscription.items.data
    .map(item => item.current_period_end)
    .filter((boundary): boundary is number => Number.isFinite(boundary) && boundary > 0);
  if (boundaries.length === 0) {
    throw new Error('Cannot safely stop renewal without a Stripe current-period boundary.');
  }
  return Math.min(...boundaries);
}

export async function stopKiloClawStripeRenewal({
  stripeSubscriptionId,
  actor,
  runId,
  deadlineAtMs = Date.now() + 20_000,
}: {
  stripeSubscriptionId: string;
  actor: StopKiloClawStripeRenewalActor;
  runId: string;
  deadlineAtMs?: number;
}): Promise<StopKiloClawStripeRenewalResult> {
  const stripeRequestOptions = () => {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error('Stripe renewal stop deadline exceeded.');
    }
    return { timeout: Math.min(5_000, remainingMs), maxNetworkRetries: 0 };
  };
  const [initialSubscription] = await db
    .select({ id: kiloclaw_subscriptions.id, user_id: kiloclaw_subscriptions.user_id })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    .limit(1);

  if (!initialSubscription) {
    throw new KiloClawStripeRenewalReconciliationConflictError();
  }

  const liveSubscription = await stripeClient.subscriptions.retrieve(
    stripeSubscriptionId,
    {},
    stripeRequestOptions()
  );
  const alreadyCanceled =
    liveSubscription.status === 'canceled' || liveSubscription.status === 'incomplete_expired';
  const originallyCanceling =
    liveSubscription.cancel_at_period_end || liveSubscription.cancel_at !== null;
  const originalCancelAt = liveSubscription.cancel_at;
  const cancelAtToPreserve =
    !alreadyCanceled && originalCancelAt !== null
      ? Math.min(originalCancelAt, earliestRenewableBoundary(liveSubscription))
      : null;
  let releasedScheduleId: string | null = null;
  let scheduleCanBeCleared = false;

  if (!alreadyCanceled) {
    const attachedScheduleId = scheduleId(liveSubscription.schedule);
    if (attachedScheduleId) {
      const schedule = await stripeClient.subscriptionSchedules.retrieve(
        attachedScheduleId,
        {},
        stripeRequestOptions()
      );
      if (schedule.status === 'active' || schedule.status === 'not_started') {
        await stripeClient.subscriptionSchedules.release(
          attachedScheduleId,
          {
            preserve_cancel_date: true,
          },
          stripeRequestOptions()
        );
        releasedScheduleId = attachedScheduleId;
        scheduleCanBeCleared = true;
      } else if (
        schedule.status !== 'released' &&
        schedule.status !== 'canceled' &&
        schedule.status !== 'completed'
      ) {
        throw new Error(
          `Cannot safely stop renewal while Stripe schedule ${attachedScheduleId} is ${schedule.status}.`
        );
      } else {
        scheduleCanBeCleared = true;
      }
    }

    const currentSubscription = releasedScheduleId
      ? await stripeClient.subscriptions.retrieve(stripeSubscriptionId, {}, stripeRequestOptions())
      : liveSubscription;
    const hasEarlierCancellation = currentSubscription.cancel_at !== null;
    if (cancelAtToPreserve !== null && currentSubscription.cancel_at !== cancelAtToPreserve) {
      await stripeClient.subscriptions.update(
        stripeSubscriptionId,
        {
          cancel_at: cancelAtToPreserve,
        },
        stripeRequestOptions()
      );
    } else if (
      !currentSubscription.cancel_at_period_end &&
      !hasEarlierCancellation &&
      liveSubscription.cancel_at === null
    ) {
      await stripeClient.subscriptions.update(
        stripeSubscriptionId,
        { cancel_at_period_end: true },
        stripeRequestOptions()
      );
    }
  }

  const providerOutcome: StopKiloClawStripeRenewalResult['outcome'] = alreadyCanceled
    ? 'already_canceled'
    : originallyCanceling
      ? 'already_canceling'
      : 'updated';

  const reconciliation = await db.transaction(async tx => {
    const [subscription] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
      .for('update')
      .limit(1);

    const conflict =
      !subscription ||
      subscription.id !== initialSubscription.id ||
      subscription.transferred_to_subscription_id !== null;

    if (conflict) {
      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.subscription.admin_cancel',
        actor_id: actor.id,
        actor_email: actor.email,
        actor_name: actor.name,
        target_user_id: initialSubscription.user_id,
        message: `Stripe renewal stop for ${stripeSubscriptionId} could not reconcile to its original KiloClaw subscription`,
        metadata: {
          runId,
          stripeSubscriptionId,
          reason: 'KiloClaw end of life',
          reconciliationStatus: 'conflict',
        },
        tx,
      });
      return { conflict: true as const };
    }

    const clearSchedule =
      releasedScheduleId !== null ||
      scheduleCanBeCleared ||
      liveSubscription.schedule === null ||
      alreadyCanceled;
    const scheduleUpdate = clearSchedule
      ? shouldPreserveScheduledConversion(subscription)
        ? { stripe_schedule_id: null }
        : { stripe_schedule_id: null, scheduled_plan: null, scheduled_by: null }
      : {};
    const [updated] = await tx
      .update(kiloclaw_subscriptions)
      .set({
        cancel_at_period_end: alreadyCanceled ? subscription.cancel_at_period_end : true,
        ...scheduleUpdate,
      })
      .where(
        and(
          eq(kiloclaw_subscriptions.id, subscription.id),
          eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      )
      .returning();

    if (!updated) {
      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.subscription.admin_cancel',
        actor_id: actor.id,
        actor_email: actor.email,
        actor_name: actor.name,
        target_user_id: initialSubscription.user_id,
        message: `Stripe renewal stop for ${stripeSubscriptionId} could not update its KiloClaw subscription`,
        metadata: {
          runId,
          stripeSubscriptionId,
          reason: 'KiloClaw end of life',
          reconciliationStatus: 'conflict',
        },
        tx,
      });
      return { conflict: true as const };
    }

    await insertKiloClawSubscriptionChangeLog(tx, {
      subscriptionId: subscription.id,
      actor: { actorType: 'user', actorId: actor.id },
      action: 'schedule_changed',
      reason: `admin_stop_stripe_renewal:${runId}`,
      before: subscription,
      after: updated,
    });
    await createKiloClawAdminAuditLog({
      action: 'kiloclaw.subscription.admin_cancel',
      actor_id: actor.id,
      actor_email: actor.email,
      actor_name: actor.name,
      target_user_id: subscription.user_id,
      message: `Stopped Stripe renewal for KiloClaw subscription ${subscription.id}`,
      metadata: {
        runId,
        reason: 'KiloClaw end of life',
        stripeSubscriptionId,
        outcome: providerOutcome,
        releasedScheduleId,
      },
      tx,
    });
    return { conflict: false as const };
  });

  if (reconciliation.conflict) {
    throw new KiloClawStripeRenewalReconciliationConflictError();
  }

  return { outcome: providerOutcome };
}
