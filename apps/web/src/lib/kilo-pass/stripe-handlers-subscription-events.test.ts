import { afterEach, beforeEach, describe, expect, test, jest } from '@jest/globals';

import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  kilo_pass_audit_log,
  kilo_pass_pause_events,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { KiloPassAuditLogResult } from './enums';
import { KiloPassAuditLogAction } from './enums';
import { KiloPassCadence } from './enums';
import { KiloPassTier } from '@/lib/kilo-pass/enums';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { and, eq } from 'drizzle-orm';
import type Stripe from 'stripe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStripeSubscriptionsRetrieve = jest.fn<any>();

jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockStripeSubscriptionsRetrieve(...args),
    },
  },
}));

function ensureKiloPassStripePriceIdEnv(): void {
  // These env vars are required at module-load time by [`getKnownStripePriceIdsForKiloPass()`](src/lib/kilo-pass/stripe-price-ids.server.ts:24).
  // If the host env already provides them, don't overwrite.
  const env = process.env;

  env.STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_monthly';
  env.STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_19_yearly';
  env.STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_monthly';
  env.STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_49_yearly';
  env.STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_monthly';
  env.STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID ||= 'price_test_kilo_pass_tier_199_yearly';
}

function kiloPassMetadata(params: {
  kiloUserId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
}): Stripe.Metadata {
  return {
    type: 'kilo-pass',
    kiloUserId: params.kiloUserId,
    tier: params.tier,
    cadence: params.cadence,
  };
}

function makeStripeSubscription(params: {
  id: string;
  start_date_seconds: number;
  metadata: Stripe.Metadata;
  status: Stripe.Subscription.Status;
  cancel_at_period_end?: boolean;
  ended_at_seconds?: number | null;
  canceled_at_seconds?: number | null;
}): Stripe.Subscription {
  return {
    id: params.id,
    object: 'subscription',
    start_date: params.start_date_seconds,
    metadata: params.metadata,
    status: params.status,
    cancel_at_period_end: params.cancel_at_period_end ?? false,
    ended_at: params.ended_at_seconds ?? null,
    canceled_at: params.canceled_at_seconds ?? null,
    items: { object: 'list', data: [], has_more: false, url: '/v1/subscription_items' },
    // Everything else is irrelevant for our handler.
  } as unknown as Stripe.Subscription;
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

beforeEach(async () => {
  ensureKiloPassStripePriceIdEnv();
  await cleanupDbForTest();
  // Default: no pause_collection
  mockStripeSubscriptionsRetrieve.mockResolvedValue({ pause_collection: null });
});

afterEach(() => {
  jest.useRealTimers();
  mockStripeSubscriptionsRetrieve.mockReset();
});

describe('handleKiloPassSubscriptionEvent', () => {
  test('throws KiloPassError when subscription does not look like Kilo Pass (no DB side effects)', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const subscription = makeStripeSubscription({
      id: `sub_non_kilo_${Math.random()}`,
      start_date_seconds: 1_735_689_600,
      status: 'active',
      metadata: {},
    });

    await expect(
      handleKiloPassSubscriptionEvent({
        eventId: 'evt_test_non_kilo',
        eventType: 'customer.subscription.updated',
        subscription,
      })
    ).rejects.toThrow('Kilo Pass subscription event missing required metadata fields');

    const subs = await db.select({ id: kilo_pass_subscriptions.id }).from(kilo_pass_subscriptions);
    expect(subs).toHaveLength(0);

    const audit = await db.select({ id: kilo_pass_audit_log.id }).from(kilo_pass_audit_log);
    expect(audit).toHaveLength(0);
  });

  test('active subscription: inserts/updates subscription row and writes webhook audit log', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_${Math.random()}`;
    const eventId = `evt_${Math.random()}`;
    const eventType = 'customer.subscription.created';
    const startDateSeconds = 1_767_225_600; // 2026-01-01T00:00:00Z

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: startDateSeconds,
      status: 'active',
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    await handleKiloPassSubscriptionEvent({ eventId, eventType, subscription });

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();
    expect(subRow?.kilo_user_id).toBe(user.id);
    expect(subRow?.tier).toBe(KiloPassTier.Tier49);
    expect(subRow?.cadence).toBe(KiloPassCadence.Monthly);
    expect(subRow?.status).toBe('active');
    expect(subRow?.cancel_at_period_end).toBe(false);
    expect(toIso(subRow?.started_at)).toBe(new Date(startDateSeconds * 1000).toISOString());
    expect(subRow?.ended_at).toBeNull();

    const auditRow = await db.query.kilo_pass_audit_log.findFirst({
      where: and(
        eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StripeWebhookReceived),
        eq(kilo_pass_audit_log.stripe_event_id, eventId)
      ),
    });

    expect(auditRow).toBeTruthy();
    expect(auditRow?.result).toBe(KiloPassAuditLogResult.Success);
    expect(auditRow?.kilo_user_id).toBe(user.id);
    expect(auditRow?.stripe_subscription_id).toBe(stripeSubId);
    expect(auditRow?.payload_json).toEqual({ type: eventType });
  });

  test('active subscription with cancel_at_period_end=true stores cancel_at_period_end flag', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_${Math.random()}`;

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'active',
      cancel_at_period_end: true,
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription,
    });

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow?.status).toBe('active');
    expect(subRow?.cancel_at_period_end).toBe(true);
    expect(subRow?.ended_at).toBeNull();
  });

  test('ended subscription: sets ended_at from ended_at when present and resets streak when transitioning to ended', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_${Math.random()}`;

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      current_streak_months: 7,
    });

    const endedAtSeconds = 1_767_311_000;
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'canceled',
      ended_at_seconds: endedAtSeconds,
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription,
    });

    const updated = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });

    expect(updated?.status).toBe('canceled');
    expect(toIso(updated?.ended_at)).toBe(new Date(endedAtSeconds * 1000).toISOString());
    expect(updated?.current_streak_months).toBe(0);
  });

  test('ended subscription: falls back to canceled_at and, when missing, uses current time', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubIdCanceledAt = `sub_canceled_at_${Math.random()}`;
    const canceledAtSeconds = 1_735_689_600;

    const subWithCanceledAt = makeStripeSubscription({
      id: stripeSubIdCanceledAt,
      start_date_seconds: 1_735_689_600,
      status: 'canceled',
      ended_at_seconds: null,
      canceled_at_seconds: canceledAtSeconds,
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier199,
        cadence: KiloPassCadence.Yearly,
      }),
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.deleted',
      subscription: subWithCanceledAt,
    });

    const updatedWithCanceledAt = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubIdCanceledAt),
    });
    expect(updatedWithCanceledAt?.status).toBe('canceled');
    expect(toIso(updatedWithCanceledAt?.ended_at)).toBe(
      new Date(canceledAtSeconds * 1000).toISOString()
    );

    const stripeSubIdNow = `sub_now_${Math.random()}`;
    const subMissingTimestamps = makeStripeSubscription({
      id: stripeSubIdNow,
      start_date_seconds: 1_735_689_600,
      status: 'unpaid',
      ended_at_seconds: null,
      canceled_at_seconds: null,
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    const beforeSeconds = Math.floor(Date.now() / 1000);

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription: subMissingTimestamps,
    });

    const afterSeconds = Math.floor(Date.now() / 1000);

    const updatedWithNow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubIdNow),
    });
    expect(updatedWithNow?.status).toBe('unpaid');
    const endedAtSeconds = updatedWithNow?.ended_at
      ? Math.floor(new Date(updatedWithNow.ended_at).getTime() / 1000)
      : null;
    expect(endedAtSeconds).not.toBeNull();
    if (endedAtSeconds === null) throw new Error('Expected ended_at to be set');
    expect(endedAtSeconds).toBeGreaterThanOrEqual(beforeSeconds);
    expect(endedAtSeconds).toBeLessThanOrEqual(afterSeconds + 1);
  });

  test('non-ended updates do not reset current_streak_months', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_${Math.random()}`;

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      ended_at: null,
      current_streak_months: 7,
    });

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'active',
      cancel_at_period_end: true,
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription,
    });

    const updated = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(updated?.status).toBe('active');
    expect(updated?.cancel_at_period_end).toBe(true);
    expect(updated?.current_streak_months).toBe(7);
  });

  test('creates pause event when subscription has pause_collection set', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_pause_${Math.random()}`;
    const resumesAtSeconds = 1_767_311_000;

    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'paused',
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      pause_collection: { behavior: 'void', resumes_at: resumesAtSeconds },
    });

    const beforeCall = new Date();

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription,
    });

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();

    const pauseEvents = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subRow!.id));

    expect(pauseEvents).toHaveLength(1);
    const pauseEvent = pauseEvents[0]!;
    expect(pauseEvent.resumed_at).toBeNull();
    expect(new Date(pauseEvent.paused_at).getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
    expect(toIso(pauseEvent.resumes_at)).toBe(new Date(resumesAtSeconds * 1000).toISOString());
  });

  test('preserves Stripe status in DB when pause_collection is set but status is active', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_pause_active_${Math.random()}`;
    const resumesAtSeconds = 1_767_311_000;

    // Stripe keeps status 'active' when pause_collection is first set (pauses at period end)
    const subscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'active',
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      pause_collection: { behavior: 'void', resumes_at: resumesAtSeconds },
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription,
    });

    // DB stores Stripe's reported status (active), not 'paused'.
    // The state query derives paused from the open pause event.
    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();
    expect(subRow!.status).toBe('active');

    const pauseEvents = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subRow!.id));
    expect(pauseEvents).toHaveLength(1);
    expect(pauseEvents[0]!.resumed_at).toBeNull();
  });

  test('closes pause event when pause_collection is cleared', async () => {
    const { handleKiloPassSubscriptionEvent } =
      await import('@/lib/kilo-pass/stripe-handlers-subscription-events');

    const user = await insertTestUser();
    const stripeSubId = `sub_resume_${Math.random()}`;
    const resumesAtSeconds = 1_767_311_000;

    // First call: subscription is paused
    const pausedSubscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'paused',
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      pause_collection: { behavior: 'void', resumes_at: resumesAtSeconds },
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription: pausedSubscription,
    });

    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubId),
    });
    expect(subRow).toBeTruthy();

    // Verify pause event was created
    const pauseEventsAfterPause = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subRow!.id));
    expect(pauseEventsAfterPause).toHaveLength(1);
    expect(pauseEventsAfterPause[0]!.resumed_at).toBeNull();

    const beforeResume = new Date();

    // Second call: subscription is active, no pause_collection
    mockStripeSubscriptionsRetrieve.mockResolvedValue({ pause_collection: null });
    const resumedSubscription = makeStripeSubscription({
      id: stripeSubId,
      start_date_seconds: 1_767_225_600,
      status: 'active',
      metadata: kiloPassMetadata({
        kiloUserId: user.id,
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      }),
    });

    await handleKiloPassSubscriptionEvent({
      eventId: `evt_${Math.random()}`,
      eventType: 'customer.subscription.updated',
      subscription: resumedSubscription,
    });

    // Verify pause event was closed
    const pauseEventsAfterResume = await db
      .select()
      .from(kilo_pass_pause_events)
      .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, subRow!.id));
    expect(pauseEventsAfterResume).toHaveLength(1);
    const closedEvent = pauseEventsAfterResume[0]!;
    expect(closedEvent.resumed_at).not.toBeNull();
    expect(new Date(closedEvent.resumed_at!).getTime()).toBeGreaterThanOrEqual(
      beforeResume.getTime()
    );
  });
});
