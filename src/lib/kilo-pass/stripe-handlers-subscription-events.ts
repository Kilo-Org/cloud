import 'server-only';

import { kilo_pass_subscriptions } from '@kilocode/db/schema';

import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';

import { KiloPassError } from '@/lib/kilo-pass/errors';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { getKiloPassSubscriptionMetadata } from '@/lib/kilo-pass/stripe-handlers-metadata';
import { getStripeEndedAtIso } from '@/lib/kilo-pass/stripe-handlers-utils';
import type Stripe from 'stripe';
import { KiloPassAuditLogAction, KiloPassAuditLogResult } from '@/lib/kilo-pass/enums';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { dayjs } from '@/lib/kilo-pass/dayjs';

export async function handleKiloPassSubscriptionEvent(params: {
  eventId: string;
  eventType: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, eventType, subscription } = params;
  const metadata = getKiloPassSubscriptionMetadata(subscription);
  if (!metadata) {
    throw new KiloPassError(
      `Kilo Pass subscription event missing required metadata fields (event_type=${eventType})`,
      {
        stripe_event_id: eventId,
        stripe_subscription_id: subscription.id,
      }
    );
  }

  const { kiloUserId, tier, cadence } = metadata;

  await db.transaction(async tx => {
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.StripeWebhookReceived,
      result: KiloPassAuditLogResult.Success,
      kiloUserId,
      stripeEventId: eventId,
      stripeSubscriptionId: subscription.id,
      payload: { type: eventType },
    });

    const stripeStatus = subscription.status;
    const cancelAtPeriodEnd = subscription.cancel_at_period_end;

    const existing = await tx.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.id),
    });

    const wasEnded = existing ? isStripeSubscriptionEnded(existing.status) : false;
    const isNowEnded = isStripeSubscriptionEnded(stripeStatus) || subscription.ended_at != null;
    const transitionedToEnded = !wasEnded && isNowEnded;

    const endedAt = isNowEnded ? getStripeEndedAtIso(subscription) : null;

    const baseValues = {
      kilo_user_id: kiloUserId,
      tier,
      cadence,
      status: stripeStatus,
      cancel_at_period_end: cancelAtPeriodEnd,
    } satisfies Partial<typeof kilo_pass_subscriptions.$inferInsert>;

    const updateSet = {
      ...baseValues,
      ended_at: endedAt,
      ...(transitionedToEnded ? { current_streak_months: 0 } : {}),
    } satisfies Partial<typeof kilo_pass_subscriptions.$inferInsert>;

    await tx
      .insert(kilo_pass_subscriptions)
      .values({
        ...baseValues,
        stripe_subscription_id: subscription.id,
        started_at: dayjs.unix(subscription.start_date).utc().toISOString(),
        ended_at: endedAt,
        current_streak_months: 0,
      })
      .onConflictDoUpdate({
        target: kilo_pass_subscriptions.stripe_subscription_id,
        set: updateSet,
      });
  });
}
