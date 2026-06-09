import 'server-only';

import { kilo_pass_audit_log, kilo_pass_subscriptions } from '@kilocode/db/schema';

import { db } from '@/lib/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { captureException } from '@sentry/nextjs';

import { KiloPassError } from '@/lib/kilo-pass/errors';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import { openPauseEvent, closePauseEvent } from '@/lib/kilo-pass/pause-events';
import { getKiloPassSubscriptionMetadata } from '@/lib/kilo-pass/stripe-handlers-metadata';
import { getStripeEndedAtIso } from '@/lib/kilo-pass/stripe-handlers-utils';
import { client as stripe } from '@/lib/stripe-client';
import type Stripe from 'stripe';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@/lib/kilo-pass/enums';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { dayjs } from '@/lib/kilo-pass/dayjs';

function isStripeResourceMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'resource_missing'
  );
}

export async function handleKiloPassSubscriptionEvent(params: {
  eventId: string;
  eventType: string;
  subscription: Stripe.Subscription;
}): Promise<void> {
  const { eventId, eventType, subscription: eventSubscription } = params;
  const eventMetadata = getKiloPassSubscriptionMetadata(eventSubscription);
  if (!eventMetadata) {
    throw new KiloPassError(
      `Kilo Pass subscription event missing required metadata fields (event_type=${eventType})`,
      {
        stripe_event_id: eventId,
        stripe_subscription_id: eventSubscription.id,
      }
    );
  }

  let finalStatus: string | undefined;
  let finalStreakMonths: number | undefined;
  let finalKiloUserId: string | undefined;
  let finalTier: string | undefined;
  let wasDuplicateDelivery = false;

  try {
    await db.transaction(async tx => {
      const lockKey = `kilo-pass:subscription:${eventSubscription.id}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      let currentSubscription: Stripe.Subscription;
      let resourceMissing = false;
      try {
        const retrievedSubscription = await stripe.subscriptions.retrieve(eventSubscription.id);
        currentSubscription = { ...eventSubscription, ...retrievedSubscription };
      } catch (error) {
        if (!isStripeResourceMissing(error)) throw error;
        currentSubscription = {
          ...eventSubscription,
          status: 'canceled',
          cancel_at_period_end: false,
          ended_at: eventSubscription.ended_at ?? eventSubscription.canceled_at,
          pause_collection: null,
        };
        resourceMissing = true;
      }

      const metadata = getKiloPassSubscriptionMetadata(currentSubscription) ?? eventMetadata;
      const { kiloUserId, tier, cadence } = metadata;
      const stripeStatus = currentSubscription.status;
      const existing = await tx.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.stripe_subscription_id, eventSubscription.id),
      });
      const priorAudit = await tx.query.kilo_pass_audit_log.findFirst({
        columns: { id: true },
        where: and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StripeWebhookReceived),
          eq(kilo_pass_audit_log.stripe_event_id, eventId)
        ),
      });
      wasDuplicateDelivery = priorAudit !== undefined;

      const wasEnded = existing ? isStripeSubscriptionEnded(existing.status) : false;
      const isNowEnded =
        isStripeSubscriptionEnded(stripeStatus) || currentSubscription.ended_at != null;
      const transitionedToEnded = !wasEnded && isNowEnded;
      const hasProviderEndedAt =
        currentSubscription.ended_at != null || currentSubscription.canceled_at != null;
      let endedAt: string | null = null;
      if (isNowEnded) {
        endedAt =
          resourceMissing && !hasProviderEndedAt && existing?.ended_at
            ? existing.ended_at
            : getStripeEndedAtIso(currentSubscription);
      }
      const baseValues = {
        kilo_user_id: kiloUserId,
        tier,
        cadence,
        status: stripeStatus,
        cancel_at_period_end: currentSubscription.cancel_at_period_end,
      } satisfies Partial<typeof kilo_pass_subscriptions.$inferInsert>;

      const upserted = await tx
        .insert(kilo_pass_subscriptions)
        .values({
          ...baseValues,
          payment_provider: KiloPassPaymentProvider.Stripe,
          provider_subscription_id: eventSubscription.id,
          stripe_subscription_id: eventSubscription.id,
          started_at: dayjs.unix(currentSubscription.start_date).utc().toISOString(),
          ended_at: endedAt,
          current_streak_months: 0,
        })
        .onConflictDoUpdate({
          target: kilo_pass_subscriptions.stripe_subscription_id,
          set: {
            ...baseValues,
            ended_at: endedAt,
            ...(transitionedToEnded ? { current_streak_months: 0 } : {}),
            payment_provider: KiloPassPaymentProvider.Stripe,
            provider_subscription_id: eventSubscription.id,
          },
        })
        .returning({
          id: kilo_pass_subscriptions.id,
          current_streak_months: kilo_pass_subscriptions.current_streak_months,
        });

      const row = upserted[0];
      if (!row)
        throw new Error(`Failed to reconcile Kilo Pass subscription ${eventSubscription.id}`);

      finalStatus = stripeStatus;
      finalStreakMonths = row.current_streak_months;
      finalKiloUserId = kiloUserId;
      finalTier = tier;

      const pauseCollection = currentSubscription.pause_collection;
      if (pauseCollection?.behavior) {
        await openPauseEvent(tx, {
          kiloPassSubscriptionId: row.id,
          pausedAt: dayjs().utc().toISOString(),
          resumesAt: pauseCollection.resumes_at
            ? dayjs.unix(pauseCollection.resumes_at).utc().toISOString()
            : null,
        });
      } else {
        await closePauseEvent(tx, {
          kiloPassSubscriptionId: row.id,
          resumedAt: dayjs().utc().toISOString(),
        });
      }

      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StripeWebhookReceived,
        result: wasDuplicateDelivery
          ? KiloPassAuditLogResult.SkippedIdempotent
          : KiloPassAuditLogResult.Success,
        kiloUserId,
        stripeEventId: eventId,
        stripeSubscriptionId: eventSubscription.id,
        payload: {
          type: eventType,
          reconciliation: 'stripe_current_state',
          eventStatus: eventSubscription.status,
          appliedStatus: stripeStatus,
          resourceMissing,
          staleDelivery: eventSubscription.status !== stripeStatus,
        },
      });
    });
  } catch (error) {
    captureException(error, {
      tags: {
        source: 'kilo_pass_subscription_reconciliation',
        stage: 'subscription_reconciliation',
      },
      extra: {
        stripeEventId: eventId,
        stripeEventType: eventType,
        stripeSubscriptionId: eventSubscription.id,
      },
    });
    throw error;
  }

  if (wasDuplicateDelivery) return;

  void reportEvents({
    events: [
      {
        type: 'billing.kilo_pass_changed',
        data: {
          kilo_user_id: finalKiloUserId ?? eventMetadata.kiloUserId,
          tier: finalTier ?? eventMetadata.tier,
          status: finalStatus ?? null,
          streak_months: finalStreakMonths,
        },
      },
    ],
  }).catch(captureException);
}
