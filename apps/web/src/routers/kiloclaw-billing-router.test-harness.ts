// Shared setup for the kiloclaw-billing-router.*.test.ts suites. Import it
// before anything else: it registers the module mocks and the shared hooks.

// Set stripe price env vars before any module loads
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID ||= 'price_legacy_standard_intro';
process.env.STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID ||= 'price_legacy_standard';
process.env.STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID ||= 'price_legacy_commit';
process.env.STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID ||= 'price_current_standard';
process.env.STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID ||= 'price_current_commit';

import { expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  user_affiliate_events,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type Stripe from 'stripe';
import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
(kiloclaw_subscriptions.kiloclaw_price_version as { defaultFn: () => string }).defaultFn = () =>
  LEGACY_KILOCLAW_PRICE_VERSION;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

type KiloclawInternalClientMockShape = {
  __provisionMock: AnyMock;
  __destroyMock: AnyMock;
  __startAsyncMock: AnyMock;
};

jest.setTimeout(15_000);

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@kilocode/web-shared/lib/stripe-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { errors } = require('stripe').default ?? require('stripe');
  const stripeMock = {
    subscriptions: { retrieve: jest.fn(), update: jest.fn(), list: jest.fn() },
    subscriptionSchedules: {
      create: jest.fn(),
      update: jest.fn(),
      release: jest.fn(),
      retrieve: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
        list: jest.fn(),
        expire: jest.fn(),
        listLineItems: jest.fn(),
      },
    },
    billingPortal: { sessions: { create: jest.fn() } },
    invoices: { list: jest.fn() },
    prices: { retrieve: jest.fn() },
    errors,
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

jest.mock('@kilocode/web-shared/lib/kiloclaw/stripe-price-ids.server', () => ({
  getStripePriceIdForClawPlan: jest.fn(() => 'price_test_kiloclaw'),
  getStripePriceIdForClawPlanIntro: jest.fn((plan: string) =>
    plan === 'standard' ? 'price_standard_intro' : 'price_commit'
  ),
  getKnownStripePriceIdsForKiloClaw: jest.fn(() => [
    'price_commit',
    'price_standard',
    'price_standard_intro',
  ]),
  getClawPlanForStripePriceId: jest.fn((priceId: string) => {
    if (priceId === 'price_commit') return 'commit';
    if (priceId === 'price_standard') return 'standard';
    if (priceId === 'price_standard_intro') return 'standard';
    return null;
  }),
  getStripePriceIdMetadata: jest.fn((priceId: string) => {
    if (priceId === 'price_commit') {
      return { plan: 'commit', priceVersion: '2026-03-19', isIntro: false };
    }
    if (priceId === 'price_standard') {
      return { plan: 'standard', priceVersion: '2026-03-19', isIntro: false };
    }
    if (priceId === 'price_standard_intro') {
      return { plan: 'standard', priceVersion: '2026-03-19', isIntro: true };
    }
    return null;
  }),
  isIntroPriceId: jest.fn((priceId: string) => priceId === 'price_standard_intro'),
}));

jest.mock('next/headers', () => {
  const fn = jest.fn as (...args: unknown[]) => AnyMock;
  return {
    cookies: fn().mockResolvedValue({ get: fn() }),
    headers: fn().mockReturnValue(new Map()),
  };
});

jest.mock('next/server', () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = jest.requireActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: jest.fn(async (work: () => Promise<void>) => await work()),
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const fn = jest.fn as (...args: unknown[]) => AnyMock;
  const provisionMock = fn().mockResolvedValue({});
  const destroyMock = fn().mockResolvedValue(undefined);
  const startAsyncMock = fn().mockResolvedValue(undefined);
  return {
    KiloClawInternalClient: fn().mockImplementation(() => ({
      start: fn().mockResolvedValue(undefined),
      startAsync: startAsyncMock,
      stop: fn().mockResolvedValue(undefined),
      destroy: destroyMock,
      provision: provisionMock,
      getStatus: fn().mockResolvedValue({}),
    })),
    KiloClawApiError: class KiloClawApiError extends Error {
      statusCode: number;
      responseBody: string;
      constructor(statusCode: number, responseBody: string) {
        super(`KiloClawApiError: ${statusCode}`);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
      }
    },
    __provisionMock: provisionMock,
    __destroyMock: destroyMock,
    __startAsyncMock: startAsyncMock,
  };
});

export const posthogCaptureMock = jest.fn();

jest.mock('@kilocode/web-shared/lib/posthog', () => ({
  __esModule: true,
  default: () => ({
    capture: posthogCaptureMock,
    isFeatureEnabled: jest.fn(),
    getFeatureFlag: jest.fn(),
    debug: jest.fn(),
    alias: jest.fn(),
  }),
}));

// ── Dynamic imports (after mocks) ──────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let createCallerForUser: (userId: string) => Promise<any>;

type StripeMockShape = {
  checkout: {
    sessions: { create: AnyMock; list: AnyMock; expire: AnyMock; listLineItems: AnyMock };
  };
  billingPortal: { sessions: { create: AnyMock } };
  subscriptions: { retrieve: AnyMock; update: AnyMock; list: AnyMock };
  subscriptionSchedules: {
    create: AnyMock;
    update: AnyMock;
    release: AnyMock;
    retrieve: AnyMock;
  };
  invoices: { list: AnyMock };
  prices: { retrieve: AnyMock };
  errors: Stripe['errors'];
};

export const stripeMock = jest.requireMock<{ __stripeMock: StripeMockShape }>(
  '@kilocode/web-shared/lib/stripe-client'
).__stripeMock;
export const stripePriceIdsMock = jest.requireMock<{
  getStripePriceIdForClawPlan: AnyMock;
  getStripePriceIdForClawPlanIntro: AnyMock;
  getKnownStripePriceIdsForKiloClaw: AnyMock;
  getClawPlanForStripePriceId: AnyMock;
  getStripePriceIdMetadata: AnyMock;
  isIntroPriceId: AnyMock;
}>('@kilocode/web-shared/lib/kiloclaw/stripe-price-ids.server');
export const kiloclawInternalClientMock = jest.requireMock<KiloclawInternalClientMockShape>(
  '@/lib/kiloclaw/kiloclaw-internal-client'
);
export const { KiloClawApiError: MockKiloClawApiError } = jest.requireMock<{
  KiloClawApiError: new (statusCode: number, responseBody: string) => Error;
}>('@/lib/kiloclaw/kiloclaw-internal-client');

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
});

// ── Helpers ────────────────────────────────────────────────────────────────

export let user: User;

beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({
    google_user_email: `kiloclaw-billing-test-${Math.random()}@example.com`,
  });
  const defaultProvisionResult = {
    sandboxId: `test-sandbox-${crypto.randomUUID()}`,
    instanceId: crypto.randomUUID(),
  };

  stripePriceIdsMock.getStripePriceIdForClawPlan.mockReset();
  stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(() => 'price_test_kiloclaw');
  stripePriceIdsMock.getStripePriceIdForClawPlanIntro.mockReset();
  stripePriceIdsMock.getStripePriceIdForClawPlanIntro.mockImplementation((plan: string) =>
    plan === 'standard' ? 'price_standard_intro' : 'price_commit'
  );
  stripePriceIdsMock.getKnownStripePriceIdsForKiloClaw.mockReset();
  stripePriceIdsMock.getKnownStripePriceIdsForKiloClaw.mockReturnValue([
    'price_commit',
    'price_standard',
    'price_standard_intro',
    'price_current_commit',
    'price_current_standard',
  ]);
  stripePriceIdsMock.getClawPlanForStripePriceId.mockReset();
  stripePriceIdsMock.getClawPlanForStripePriceId.mockImplementation((priceId: string) => {
    if (priceId === 'price_commit') return 'commit';
    if (priceId === 'price_standard') return 'standard';
    if (priceId === 'price_standard_intro') return 'standard';
    if (priceId === 'price_current_commit') return 'commit';
    if (priceId === 'price_current_standard') return 'standard';
    return null;
  });
  stripePriceIdsMock.getStripePriceIdMetadata.mockReset();
  stripePriceIdsMock.getStripePriceIdMetadata.mockImplementation((priceId: string) => {
    if (priceId === 'price_commit') {
      return {
        plan: 'commit',
        priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
        isIntro: false,
      };
    }
    if (priceId === 'price_standard') {
      return {
        plan: 'standard',
        priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
        isIntro: false,
      };
    }
    if (priceId === 'price_standard_intro') {
      return {
        plan: 'standard',
        priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
        isIntro: true,
      };
    }
    if (priceId === 'price_current_commit') {
      return {
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        isIntro: false,
      };
    }
    if (priceId === 'price_current_standard') {
      return {
        plan: 'standard',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        isIntro: false,
      };
    }
    return null;
  });
  stripePriceIdsMock.isIntroPriceId.mockReset();
  stripePriceIdsMock.isIntroPriceId.mockImplementation(
    (priceId: string) => priceId === 'price_standard_intro'
  );

  // Reset stripe mocks
  stripeMock.checkout.sessions.create.mockReset();
  stripeMock.checkout.sessions.list.mockReset();
  stripeMock.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false });
  stripeMock.checkout.sessions.expire.mockReset();
  stripeMock.checkout.sessions.expire.mockResolvedValue({});
  stripeMock.checkout.sessions.listLineItems.mockReset();
  stripeMock.checkout.sessions.listLineItems.mockResolvedValue({ data: [], has_more: false });
  stripeMock.billingPortal.sessions.create.mockReset();
  stripeMock.subscriptions.retrieve.mockReset();
  stripeMock.subscriptions.update.mockReset();
  stripeMock.subscriptions.list.mockReset();
  stripeMock.subscriptions.list.mockResolvedValue({ data: [], has_more: false });
  stripeMock.subscriptionSchedules.create.mockReset();
  stripeMock.subscriptionSchedules.update.mockReset();
  stripeMock.subscriptionSchedules.release.mockReset();
  stripeMock.subscriptionSchedules.retrieve.mockReset();
  stripeMock.invoices.list.mockReset();
  stripeMock.invoices.list.mockResolvedValue({ data: [], has_more: false });
  stripeMock.prices.retrieve.mockReset();
  stripeMock.prices.retrieve.mockResolvedValue({
    id: 'price_test_kilo_pass',
    currency: 'usd',
    unit_amount: 1900,
    tax_behavior: 'unspecified',
  });
  kiloclawInternalClientMock.__provisionMock.mockReset();
  kiloclawInternalClientMock.__provisionMock.mockResolvedValue(defaultProvisionResult);
  kiloclawInternalClientMock.__destroyMock.mockReset();
  kiloclawInternalClientMock.__destroyMock.mockResolvedValue(undefined);
  kiloclawInternalClientMock.__startAsyncMock.mockReset();
  kiloclawInternalClientMock.__startAsyncMock.mockResolvedValue(undefined);
  posthogCaptureMock.mockReset();

  // Default mock returns for live-fetch calls
  stripeMock.subscriptions.retrieve.mockResolvedValue({
    schedule: null,
    items: { data: [{ price: { id: 'price_standard' } }] },
  });
  stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
    id: 'sub_sched_test',
    metadata: {},
    phases: [],
    end_behavior: 'release',
    status: 'active',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(async () => {
  try {
    await cleanupDbForTest();
  } catch {
    // DB may already be torn down by framework
  }
});

export function makeStripeSubscription(params: {
  id: string;
  metadata: Stripe.Metadata;
  status: Stripe.Subscription.Status;
  cancel_at_period_end?: boolean;
  priceId?: string;
  created?: number;
}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: params.id,
    object: 'subscription',
    created: params.created ?? now,
    metadata: params.metadata,
    status: params.status,
    cancel_at_period_end: params.cancel_at_period_end ?? false,
    items: {
      object: 'list',
      data: params.priceId
        ? [
            {
              price: { id: params.priceId },
              current_period_start: now,
              // 30-day period is used for both standard (monthly) and commit
              // (6-month) plan fixtures. The fixture period length does not
              // affect billing logic; only the Stripe price ID determines
              // the plan. Stripe's real period would be ~180 days for commit.
              current_period_end: now + 86400 * 30,
            },
          ]
        : [],
      has_more: false,
      url: '/v1/subscription_items',
    },
    current_period_start: now,
    current_period_end: now + 86400 * 30,
  } as unknown as Stripe.Subscription;
}

export async function createKiloclawInstance(userId: string, destroyedAt?: string) {
  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      destroyed_at: destroyedAt,
    })
    .returning();

  if (!instance) {
    throw new Error('Failed to insert KiloClaw instance');
  }

  return instance;
}

type PersonalSubscriptionFixtureInput = Omit<
  typeof kiloclaw_subscriptions.$inferInsert,
  'user_id' | 'instance_id'
> & {
  userId?: string;
  instanceId?: string | null;
};

export async function insertPersonalSubscriptionFixture(params: PersonalSubscriptionFixtureInput) {
  const { userId = user.id, instanceId, ...subscriptionValues } = params;
  const resolvedInstanceId =
    instanceId === undefined ? (await createKiloclawInstance(userId)).id : instanceId;

  return await db.insert(kiloclaw_subscriptions).values({
    user_id: userId,
    instance_id: resolvedInstanceId,
    ...subscriptionValues,
  });
}

export const PRE_COMMIT_CUTOFF_TIME = '2026-06-05T12:00:00.000Z';
export const FINAL_COMMIT_START = '2026-05-01T00:00:00.000Z';
export const FINAL_COMMIT_END = '2026-11-01T00:00:00.000Z';

export function setTestSystemTime(timestamp: string) {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'setInterval',
      'setImmediate',
      'clearTimeout',
      'clearInterval',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
    ],
  });
  jest.setSystemTime(new Date(timestamp));
}

export async function insertFinalCommitFixture(params?: {
  stripeSubscriptionId?: string;
  cancelAtPeriodEnd?: boolean;
}) {
  const instance = await createKiloclawInstance(user.id);
  const [subscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: params?.stripeSubscriptionId,
      payment_source: params?.stripeSubscriptionId ? 'stripe' : 'credits',
      plan: 'commit',
      status: 'active',
      cancel_at_period_end: params?.cancelAtPeriodEnd ?? true,
      current_period_start: FINAL_COMMIT_START,
      current_period_end: FINAL_COMMIT_END,
      credit_renewal_at: params?.stripeSubscriptionId ? null : FINAL_COMMIT_END,
      commit_ends_at: FINAL_COMMIT_END,
    })
    .returning();
  if (!subscription) throw new Error('Failed to insert final Commit fixture');
  return { instance, subscription };
}

export async function seedDeliveredImpactSignupEvent(
  userId: string,
  email: string,
  conversionDate = new Date()
) {
  const { recordAffiliateAttributionAndQueueParentEvent } =
    await import('@/lib/impact/affiliate-events');
  const { recordImpactAffiliateTouch } = await import('@/lib/impact/referral');
  const eventDate = new Date(conversionDate.getTime() - 10 * 60_000);
  const signupDeliveredAt = new Date(conversionDate.getTime() - 6 * 60_000);

  const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
    userId,
    provider: 'impact',
    trackingId: 'impact-click-123',
    customerEmail: email,
    eventDate,
  });

  await recordImpactAffiliateTouch({
    userId,
    touch: {
      trackingId: 'impact-click-123',
      trackingValueLength: 'impact-click-123'.length,
      isTrackingValueAccepted: true,
      landingPath: '/pricing?im_ref=impact-click-123',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      touchedAt: eventDate,
      expiresAt: new Date(conversionDate.getTime() + 30 * 86_400_000),
    },
  });

  expect(parentEvent).not.toBeNull();

  await db
    .update(user_affiliate_events)
    .set({
      delivery_state: 'delivered',
      claimed_at: signupDeliveredAt.toISOString(),
      next_retry_at: null,
    })
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    .where(eq(user_affiliate_events.id, parentEvent!.id));
}

export async function createCanceledTrialAndPaidSubscriptions(params?: {
  userId?: string;
  paidStatus?: 'active' | 'past_due' | 'unpaid';
  paidPlan?: 'standard' | 'commit';
  paidStripeSubscriptionId?: string;
  paidCancelAtPeriodEnd?: boolean;
  paidStripeScheduleId?: string;
  paidScheduledPlan?: 'standard' | 'commit';
  paidScheduledBy?: 'user' | 'auto';
}) {
  const userId = params?.userId ?? user.id;
  const trialInstance = await createKiloclawInstance(userId, '2026-04-01T00:00:00.000Z');
  const paidInstance = await createKiloclawInstance(userId);

  const [paidSubscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: userId,
      instance_id: paidInstance.id,
      stripe_subscription_id: params?.paidStripeSubscriptionId ?? `sub-paid-${crypto.randomUUID()}`,
      plan: params?.paidPlan ?? 'standard',
      status: params?.paidStatus ?? 'active',
      cancel_at_period_end: params?.paidCancelAtPeriodEnd ?? false,
      stripe_schedule_id: params?.paidStripeScheduleId,
      scheduled_plan: params?.paidScheduledPlan,
      scheduled_by: params?.paidScheduledBy,
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    })
    .returning();
  const [trialSubscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: userId,
      instance_id: trialInstance.id,
      plan: 'trial',
      status: 'canceled',
      trial_started_at: '2026-03-01T00:00:00.000Z',
      trial_ends_at: '2026-03-08T00:00:00.000Z',
      transferred_to_subscription_id: paidSubscription?.id,
    })
    .returning();

  if (!trialSubscription || !paidSubscription) {
    throw new Error('Failed to insert paired KiloClaw subscriptions');
  }

  return {
    trialInstance,
    paidInstance,
    trialSubscription,
    paidSubscription,
  };
}
