// Set stripe price env vars before any module loads
process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_FIRST_MONTH_COUPON_ID ||=
  'coupon_test_kiloclaw_standard_first_month';
process.env.STRIPE_KILOCLAW_BILLING_START ||= '2026-03-23T00:00:00Z';

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_earlybird_purchases,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type Stripe from 'stripe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@/lib/stripe-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { errors } = require('stripe').default ?? require('stripe');
  const stripeMock = {
    subscriptions: { retrieve: jest.fn(), update: jest.fn(), list: jest.fn() },
    subscriptionSchedules: { create: jest.fn(), update: jest.fn(), release: jest.fn() },
    checkout: { sessions: { create: jest.fn(), list: jest.fn(), expire: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    errors,
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

jest.mock('@/lib/rewardful', () => ({
  getRewardfulReferral: jest.fn(),
}));

jest.mock('@/lib/kiloclaw/stripe-price-ids.server', () => ({
  getStripePriceIdForClawPlan: jest.fn(() => 'price_test_kiloclaw'),
  getClawPlanForStripePriceId: jest.fn((priceId: string) => {
    if (priceId === 'price_commit') return 'commit';
    if (priceId === 'price_standard') return 'standard';
    return null;
  }),
}));

jest.mock('next/headers', () => {
  const fn = jest.fn as (...args: unknown[]) => AnyMock;
  return {
    cookies: fn().mockResolvedValue({ get: fn() }),
    headers: fn().mockReturnValue(new Map()),
  };
});

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const fn = jest.fn as (...args: unknown[]) => AnyMock;
  return {
    KiloClawInternalClient: fn().mockImplementation(() => ({
      start: fn().mockResolvedValue(undefined),
      stop: fn().mockResolvedValue(undefined),
      provision: fn().mockResolvedValue({}),
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
  };
});

// ── Dynamic imports (after mocks) ──────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCallerForUser: (userId: string) => Promise<any>;

type StripeMockShape = {
  checkout: { sessions: { create: AnyMock; list: AnyMock; expire: AnyMock } };
  billingPortal: { sessions: { create: AnyMock } };
  subscriptions: { retrieve: AnyMock; update: AnyMock; list: AnyMock };
  subscriptionSchedules: { create: AnyMock; update: AnyMock; release: AnyMock };
  errors: Stripe['errors'];
};

const stripeMock = jest.requireMock<{ __stripeMock: StripeMockShape }>(
  '@/lib/stripe-client'
).__stripeMock;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let user: User;

beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({
    google_user_email: `kiloclaw-billing-test-${Math.random()}@example.com`,
  });

  // Reset stripe mocks
  stripeMock.checkout.sessions.create.mockReset();
  stripeMock.checkout.sessions.list.mockReset();
  stripeMock.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripeMock.checkout.sessions.expire.mockReset();
  stripeMock.checkout.sessions.expire.mockResolvedValue({});
  stripeMock.billingPortal.sessions.create.mockReset();
  stripeMock.subscriptions.retrieve.mockReset();
  stripeMock.subscriptions.update.mockReset();
  stripeMock.subscriptions.list.mockReset();
  stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
  stripeMock.subscriptionSchedules.create.mockReset();
  stripeMock.subscriptionSchedules.update.mockReset();
  stripeMock.subscriptionSchedules.release.mockReset();

  // Reset rewardful mock
  const { getRewardfulReferral } = jest.requireMock<{
    getRewardfulReferral: AnyMock;
  }>('@/lib/rewardful');
  getRewardfulReferral.mockResolvedValue(undefined);
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

function makeStripeSubscription(params: {
  id: string;
  metadata: Stripe.Metadata;
  status: Stripe.Subscription.Status;
  cancel_at_period_end?: boolean;
  priceId?: string;
}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: params.id,
    object: 'subscription',
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getBillingStatus', () => {
  it('returns trialEligible true when user has no instance rows and no subscription', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(true);
  });

  it('returns trialEligible false when user has an instance row (including destroyed)', async () => {
    await db.insert(kiloclaw_instances).values({
      user_id: user.id,
      sandbox_id: 'sandbox-destroyed',
      destroyed_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
  });

  it('returns trialEligible false when user has a canceled subscription but no instance', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_canceled_old',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
  });

  it('returns trialEligible false when user has an earlybird purchase', async () => {
    await db.insert(kiloclaw_earlybird_purchases).values({
      user_id: user.id,
      amount_cents: 2500,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
  });
});

describe('createSubscriptionCheckout', () => {
  it('applies the configured first-month coupon for standard plan', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.discounts).toEqual([{ coupon: 'coupon_test_kiloclaw_standard_first_month' }]);
    expect(callArgs.allow_promotion_codes).toBeUndefined();
  });

  it('does not set discounts or promotion codes for commit plan', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'commit' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.discounts).toBeUndefined();
    expect(callArgs.allow_promotion_codes).toBeUndefined();
  });

  it('does not apply the first-month coupon for returning canceled subscribers', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_returning_standard',
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.discounts).toBeUndefined();
    expect(callArgs.allow_promotion_codes).toBeUndefined();
  });

  it('includes client_reference_id when rewardful cookie is set', async () => {
    const { getRewardfulReferral } = jest.requireMock<{
      getRewardfulReferral: AnyMock;
    }>('@/lib/rewardful');
    getRewardfulReferral.mockResolvedValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      })
    );
  });

  it('sets trial_end in subscription_data when before March 23', async () => {
    const realDateNow = Date.now;
    Date.now = () => new Date('2026-03-12T00:00:00Z').getTime();

    try {
      stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const subscriptionData = callArgs.subscription_data as Record<string, unknown>;
    const expectedTrialEnd = Math.floor(new Date('2026-03-23T00:00:00Z').getTime() / 1000);
    expect(subscriptionData.trial_end).toBe(expectedTrialEnd);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('does not set trial_end when after March 23', async () => {
    // Temporarily override Date.now to simulate being after March 23
    const realDateNow = Date.now;
    Date.now = () => new Date('2026-04-01T00:00:00Z').getTime();

    try {
      stripeMock.checkout.sessions.create.mockResolvedValue({
        url: 'https://checkout.stripe.com/test',
      });

      const caller = await createCallerForUser(user.id);
      await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

      const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const subscriptionData = callArgs.subscription_data as Record<string, unknown>;
      expect(subscriptionData.trial_end).toBeUndefined();
    } finally {
      Date.now = realDateNow;
    }
  });
});

describe('handleKiloClawSubscriptionUpdated', () => {
  let handleKiloClawSubscriptionUpdated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionUpdated = mod.handleKiloClawSubscriptionUpdated;
  });

  it('maps Stripe trialing status with commit plan to local active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_trial',
      plan: 'commit',
      status: 'trialing',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_trial',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'trialing',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_trialing',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('commit');
  });

  it('maps Stripe trialing status with standard plan to local active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_standard_trial',
      plan: 'standard',
      status: 'trialing',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_standard_trial',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'trialing',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_standard_trialing',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('standard');
  });

  it('maps Stripe active status to local active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_active',
      plan: 'standard',
      status: 'active',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_active',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_active',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('standard');
  });

  it('auto-extends commit_ends_at by one window when boundary just passed', async () => {
    const pastCommitEnd = new Date(Date.now() - 86_400_000).toISOString();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_renew',
      plan: 'commit',
      status: 'active',
      commit_ends_at: pastCommitEnd,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_renew',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_renew',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.commit_ends_at).not.toBeNull();
    const extendedEnd = new Date(row.commit_ends_at!);
    // Result must be in the future
    expect(extendedEnd.getTime()).toBeGreaterThan(Date.now());
    // Should be approximately 6 months after the old boundary
    const oldEnd = new Date(pastCommitEnd);
    const diffDays = (extendedEnd.getTime() - oldEnd.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(178);
    expect(diffDays).toBeLessThanOrEqual(184);
  });

  it('auto-extends commit_ends_at across multiple windows when far overdue', async () => {
    // Boundary is ~7 months ago — should advance by 2 windows (12 months) to land in the future
    const farPastCommitEnd = new Date(Date.now() - 215 * 86_400_000).toISOString();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_overdue',
      plan: 'commit',
      status: 'active',
      commit_ends_at: farPastCommitEnd,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_overdue',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_overdue',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.commit_ends_at).not.toBeNull();
    const extendedEnd = new Date(row.commit_ends_at!);
    // Result must be in the future — this is the critical assertion
    expect(extendedEnd.getTime()).toBeGreaterThan(Date.now());
    // Should have advanced by approximately 12 months (2 x 6-month windows)
    const oldEnd = new Date(farPastCommitEnd);
    const diffDays = (extendedEnd.getTime() - oldEnd.getTime()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(360); // ~12 months
    expect(diffDays).toBeLessThanOrEqual(368);
  });

  it('ignores stale subscription.updated for a superseded subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_new',
      plan: 'standard',
      status: 'active',
    });

    // Stale webhook for an old subscription that was replaced
    const staleSubscription = makeStripeSubscription({
      id: 'sub_old',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'past_due',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_stale',
      subscription: staleSubscription,
    });

    // Local row should be unchanged — the stale webhook matched 0 rows
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_new');
    expect(row.plan).toBe('standard');
    expect(row.status).toBe('active');
  });
});

describe('handleKiloClawSubscriptionCreated', () => {
  let handleKiloClawSubscriptionCreated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionCreated = mod.handleKiloClawSubscriptionCreated;
  });

  it('upgrades a trial row to a paid subscription', async () => {
    // User has a trial row (stripe_subscription_id is null)
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const subscription = makeStripeSubscription({
      id: 'sub_paid',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_trial_upgrade',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_paid');
    expect(row.plan).toBe('standard');
    expect(row.status).toBe('active');
  });

  it('sets commit_ends_at for a new commit subscription', async () => {
    const subscription = makeStripeSubscription({
      id: 'sub_commit_new',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_commit_created',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_commit_new');
    expect(row.plan).toBe('commit');
    expect(row.status).toBe('active');
    // commit_ends_at should be set (6 months from period start)
    expect(row.commit_ends_at).not.toBeNull();
    // No schedule should be created — commit plans auto-renew
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('ignores stale subscription.created when user has a different active subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_current',
      plan: 'standard',
      status: 'active',
    });

    const staleSubscription = makeStripeSubscription({
      id: 'sub_stale',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_stale_created',
      subscription: staleSubscription,
    });

    // Row should be unchanged
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_current');
    expect(row.plan).toBe('standard');
  });
});

describe('cancelSubscription', () => {
  it('sets cancel_at_period_end for commit subscription without schedule', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit',
      plan: 'commit',
      status: 'active',
    });

    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_commit', {
      cancel_at_period_end: true,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
  });

  it('releases user-initiated plan switch schedule on cancel', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_with_switch',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_user',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_user');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('proceeds when schedule is already released', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_2',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_gone',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(
      new Error('This schedule is not active and cannot be released')
    );
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
  });

  it('aborts cancellation when schedule release fails with transient error', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_3',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_fail',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe API timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelSubscription()).rejects.toThrow(
      'Unable to cancel: failed to release pending plan schedule.'
    );

    // Local state must be unchanged — schedule still referenced
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sched_fail');
    expect(row.cancel_at_period_end).toBe(false);
  });
});

describe('reactivateSubscription', () => {
  it('clears cancel_at_period_end for commit subscription', async () => {
    const futureCommitEnd = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_reactivate',
      plan: 'commit',
      status: 'active',
      cancel_at_period_end: true,
      commit_ends_at: futureCommitEnd,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_reactivate', {
      cancel_at_period_end: false,
    });
    // No schedule creation — commit plans auto-renew without a schedule
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(false);
    // commit_ends_at preserved (compare as dates to avoid format mismatch)
    expect(new Date(row.commit_ends_at!).getTime()).toBe(new Date(futureCommitEnd).getTime());
  });
});

describe('createSubscriptionCheckout — concurrent checkout guard', () => {
  it('expires stale open checkout sessions and creates a new one', async () => {
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_existing', metadata: { type: 'kiloclaw' } }],
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_new',
      url: 'https://checkout.stripe.com/new',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith('cs_existing');
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(result).toEqual({ url: 'https://checkout.stripe.com/new' });
  });

  it('swallows expire errors (session already expired or completed)', async () => {
    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [{ id: 'cs_gone', metadata: { type: 'kiloclaw' } }],
    });
    stripeMock.checkout.sessions.expire.mockRejectedValue(new Error('session no longer open'));
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_new',
      url: 'https://checkout.stripe.com/new',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith('cs_gone');
    expect(result).toEqual({ url: 'https://checkout.stripe.com/new' });
  });

  it('rejects when an active Stripe subscription already exists', async () => {
    const activeSub = makeStripeSubscription({
      id: 'sub_stripe_active',
      metadata: { type: 'kiloclaw' },
      status: 'active',
      priceId: 'price_standard',
    });

    stripeMock.subscriptions.list
      .mockResolvedValueOnce({ data: [activeSub] }) // active query
      .mockResolvedValueOnce({ data: [] }); // trialing query
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [] });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );
  });
});
