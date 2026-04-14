// Set stripe price env vars before any module loads
process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

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
  kilocode_users,
  credit_transactions,
  kilo_pass_subscriptions,
  user_affiliate_attributions,
  user_affiliate_events,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@/lib/kiloclaw/sandbox-id';
import { createOrganization } from '@/lib/organizations/organizations';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type Stripe from 'stripe';
import { KiloPassTier, KiloPassCadence } from '@/lib/kilo-pass/enums';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.setTimeout(15_000);

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@/lib/stripe-client', () => {
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
    checkout: { sessions: { create: jest.fn(), list: jest.fn(), expire: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    invoices: { list: jest.fn() },
    errors,
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

jest.mock('@/lib/kiloclaw/stripe-price-ids.server', () => ({
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
  subscriptionSchedules: { create: AnyMock; update: AnyMock; release: AnyMock; retrieve: AnyMock };
  invoices: { list: AnyMock };
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
  stripeMock.subscriptionSchedules.retrieve.mockReset();
  stripeMock.invoices.list.mockReset();
  stripeMock.invoices.list.mockResolvedValue({ data: [], has_more: false });

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

function makeStripeSubscription(params: {
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

async function createKiloclawInstance(userId: string, destroyedAt?: string) {
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

async function seedDeliveredImpactSignupEvent(userId: string, email: string) {
  const { recordAffiliateAttributionAndQueueParentEvent } = await import('@/lib/affiliate-events');
  const parentEvent = await recordAffiliateAttributionAndQueueParentEvent({
    userId,
    provider: 'impact',
    trackingId: 'impact-click-123',
    customerEmail: email,
    eventDate: new Date('2026-04-09T10:00:00.000Z'),
  });

  expect(parentEvent).not.toBeNull();

  await db
    .update(user_affiliate_events)
    .set({
      delivery_state: 'delivered',
      claimed_at: null,
      next_retry_at: null,
    })
    .where(eq(user_affiliate_events.id, parentEvent!.id));
}

async function createCanceledTrialAndPaidSubscriptions(params?: {
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

  const [trialSubscription, paidSubscription] = await db
    .insert(kiloclaw_subscriptions)
    .values([
      {
        user_id: userId,
        instance_id: trialInstance.id,
        plan: 'trial',
        status: 'canceled',
        trial_started_at: '2026-03-01T00:00:00.000Z',
        trial_ends_at: '2026-03-08T00:00:00.000Z',
      },
      {
        user_id: userId,
        instance_id: paidInstance.id,
        stripe_subscription_id:
          params?.paidStripeSubscriptionId ?? `sub-paid-${crypto.randomUUID()}`,
        plan: params?.paidPlan ?? 'standard',
        status: params?.paidStatus ?? 'active',
        cancel_at_period_end: params?.paidCancelAtPeriodEnd ?? false,
        stripe_schedule_id: params?.paidStripeScheduleId,
        scheduled_plan: params?.paidScheduledPlan,
        scheduled_by: params?.paidScheduledBy,
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
      },
    ])
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

  it('returns trialEligible false when user only has an org-backed subscription', async () => {
    const organization = await createOrganization('Org Trial Test', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: orgInstance.id,
      stripe_subscription_id: 'sub_org_trial_test',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    // Must be false — ensureProvisionAccess checks ALL subscriptions (including
    // org) and would block trial creation, so trialEligible must agree.
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

  it('prefers an active subscription over an older canceled row', async () => {
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        plan: 'standard',
        status: 'canceled',
        stripe_subscription_id: 'sub_status_canceled_old',
        current_period_end: '2026-03-01T00:00:00.000Z',
      },
      {
        user_id: user.id,
        plan: 'standard',
        status: 'active',
        stripe_subscription_id: 'sub_status_active_latest',
        current_period_end: '2026-05-01T00:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.currentPeriodEnd).toBe('2026-05-01T00:00:00.000Z');
  });

  it('prefers an active paid subscription over a canceled trial on a destroyed instance', async () => {
    const { trialInstance } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_status_effective_paid',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.currentPeriodEnd).toBe('2026-05-01T00:00:00.000Z');
    expect(result.instance?.exists).toBe(true);
    expect(result.instance?.destroyed).toBe(false);

    const adoptedTrialRows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, trialInstance.id));
    expect(adoptedTrialRows).toHaveLength(1);
  });
});

describe('requireKiloClawAccess', () => {
  it('logs structured subscription diagnostics before rejecting', async () => {
    const { requireKiloClawAccess } = await import('@/lib/kiloclaw/access-gate');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const destroyedInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
      await db.insert(kiloclaw_subscriptions).values([
        {
          user_id: user.id,
          instance_id: destroyedInstance.id,
          plan: 'trial',
          status: 'canceled',
          trial_started_at: '2026-03-01T00:00:00.000Z',
          trial_ends_at: '2026-03-08T00:00:00.000Z',
        },
        {
          user_id: user.id,
          instance_id: null,
          plan: 'standard',
          status: 'canceled',
          current_period_end: '2026-04-01T00:00:00.000Z',
          suspended_at: '2026-04-02T00:00:00.000Z',
        },
      ]);

      await expect(requireKiloClawAccess(user.id)).rejects.toThrow(
        'KiloClaw access requires an active subscription, trial, or earlybird purchase.'
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warnArg] = warnSpy.mock.calls[0] ?? [];
      expect(typeof warnArg).toBe('string');
      const parsed = JSON.parse(warnArg as string) as {
        event: string;
        userId: string;
        subscriptionCount: number;
        effectiveSubscription:
          | {
              id: string;
              status: string;
              plan: string;
              suspended_at: string | null;
              instance_id: string | null;
            }
          | 'none';
        accessReason: string | null;
        earlybirdFound: boolean;
      };

      expect(parsed).toMatchObject({
        event: 'kiloclaw_access_denied',
        userId: user.id,
        subscriptionCount: 2,
        accessReason: null,
        earlybirdFound: false,
      });
      expect(parsed.effectiveSubscription).not.toBe('none');
      expect(parsed.effectiveSubscription).toMatchObject({
        status: 'canceled',
        plan: 'standard',
        suspended_at: expect.stringContaining('2026-04-02'),
        instance_id: null,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('subscription center procedures', () => {
  async function createInstanceRow(params: {
    userId: string;
    organizationId?: string;
    name?: string;
    destroyedAt?: string;
    sandboxId?: string;
  }) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: params.userId,
        organization_id: params.organizationId,
        name: params.name,
        destroyed_at: params.destroyedAt,
        sandbox_id: params.sandboxId ?? `sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    if (!instance) {
      throw new Error('Failed to insert KiloClaw instance');
    }

    return instance;
  }

  async function insertSubscriptionRow(params: {
    userId: string;
    instanceId: string;
    stripeSubscriptionId?: string;
    paymentSource?: 'credits';
    plan: 'standard' | 'commit' | 'trial';
    status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trialing';
    createdAt?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    creditRenewalAt?: string;
    cancelAtPeriodEnd?: boolean;
  }) {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: params.userId,
      instance_id: params.instanceId,
      stripe_subscription_id: params.stripeSubscriptionId,
      payment_source: params.paymentSource,
      plan: params.plan,
      status: params.status,
      created_at: params.createdAt,
      current_period_start: params.currentPeriodStart,
      current_period_end: params.currentPeriodEnd,
      credit_renewal_at: params.creditRenewalAt,
      cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
    });
  }

  it('lists only personal subscriptions for the current user', async () => {
    const organization = await createOrganization('Subscription Center Org', user.id);
    const olderPersonalInstance = await createInstanceRow({
      userId: user.id,
      name: 'Older Personal',
    });
    const newerPersonalInstance = await createInstanceRow({
      userId: user.id,
      name: 'Newer Personal',
    });
    const orgInstance = await createInstanceRow({
      userId: user.id,
      organizationId: organization.id,
      name: 'Org Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: olderPersonalInstance.id,
      stripeSubscriptionId: 'sub_personal_old',
      plan: 'standard',
      status: 'active',
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: newerPersonalInstance.id,
      paymentSource: 'credits',
      plan: 'commit',
      status: 'active',
      createdAt: '2026-04-02T00:00:00.000Z',
      creditRenewalAt: '2026-10-02T00:00:00.000Z',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: orgInstance.id,
      stripeSubscriptionId: 'sub_org_owned',
      plan: 'standard',
      status: 'active',
      createdAt: '2026-04-03T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.listPersonalSubscriptions();

    expect(result.subscriptions).toHaveLength(2);
    expect(
      result.subscriptions.map((subscription: { instanceId: string }) => subscription.instanceId)
    ).toEqual([newerPersonalInstance.id, olderPersonalInstance.id]);
    expect(result.subscriptions[0]).toMatchObject({
      instanceId: newerPersonalInstance.id,
      plan: 'commit',
      paymentSource: 'credits',
      hasStripeFunding: false,
    });
    expect(result.subscriptions[1]).toMatchObject({
      instanceId: olderPersonalInstance.id,
      plan: 'standard',
      paymentSource: null,
      hasStripeFunding: true,
    });
  });

  it('returns detail for the requested personal subscription', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Target Personal Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      paymentSource: 'credits',
      plan: 'standard',
      status: 'active',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
      creditRenewalAt: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getSubscriptionDetail({ instanceId: instance.id });

    expect(result).toMatchObject({
      instanceId: instance.id,
      instanceName: 'Target Personal Instance',
      plan: 'standard',
      status: 'active',
      paymentSource: 'credits',
      hasStripeFunding: false,
      creditRenewalAt: '2026-05-01T00:00:00.000Z',
    });
  });

  it('rejects detail requests for org-owned instances', async () => {
    const organization = await createOrganization('Org Owned Detail', user.id);
    const instance = await createInstanceRow({
      userId: user.id,
      organizationId: organization.id,
      name: 'Org Detail Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_org_detail',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.getSubscriptionDetail({ instanceId: instance.id })
    ).rejects.toThrow('Subscription not found.');
  });

  it('lists Stripe billing history for the requested Stripe-funded instance', async () => {
    stripeMock.invoices.list.mockResolvedValue({
      data: [
        {
          id: 'inv_kiloclaw_1',
          created: 1_711_965_600,
          amount_due: 900,
          currency: 'usd',
          status: 'paid',
          hosted_invoice_url: 'https://stripe.example.test/inv_kiloclaw_1',
          invoice_pdf: 'https://stripe.example.test/inv_kiloclaw_1.pdf',
          lines: { data: [{ description: 'KiloClaw standard plan' }] },
        },
      ],
      has_more: false,
    });

    const instance = await createInstanceRow({ userId: user.id, name: 'Stripe Instance' });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_kiloclaw_stripe',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingHistory({ instanceId: instance.id });

    expect(stripeMock.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_kiloclaw_stripe',
      limit: 25,
    });
    expect(result).toEqual({
      entries: [
        {
          kind: 'stripe',
          id: 'inv_kiloclaw_1',
          date: new Date(1_711_965_600 * 1000).toISOString(),
          amountCents: 900,
          currency: 'usd',
          status: 'paid',
          invoiceUrl: 'https://stripe.example.test/inv_kiloclaw_1',
          invoicePdfUrl: 'https://stripe.example.test/inv_kiloclaw_1.pdf',
          description: 'KiloClaw standard plan',
        },
      ],
      hasMore: false,
      cursor: null,
    });
  });

  it('lists credit-funded billing history for the requested instance', async () => {
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    const oldInstance = await createInstanceRow({
      userId: user.id,
      name: 'Old Credits Instance',
      sandboxId,
      destroyedAt: '2026-04-15T00:00:00.000Z',
    });
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Credits Instance',
      sandboxId,
    });
    const otherInstance = await createInstanceRow({ userId: user.id, name: 'Other Instance' });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      paymentSource: 'credits',
      plan: 'standard',
      status: 'active',
      creditRenewalAt: '2026-06-01T00:00:00.000Z',
    });

    await db.insert(credit_transactions).values([
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'Standard renewal',
        credit_category: `kiloclaw-subscription:${instance.id}:2026-04`,
        created_at: '2026-04-01T12:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -48_000_000,
        is_free: false,
        description: 'Commit renewal',
        credit_category: `kiloclaw-subscription-commit:${oldInstance.id}:2026-05`,
        created_at: '2026-05-01T12:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'Other instance renewal',
        credit_category: `kiloclaw-subscription:${otherInstance.id}:2026-06`,
        created_at: '2026-06-01T12:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingHistory({ instanceId: instance.id });

    expect(result).toEqual({
      entries: [
        {
          kind: 'credits',
          id: expect.any(String),
          date: '2026-05-01T12:00:00.000Z',
          amountMicrodollars: 48_000_000,
          description: 'Commit renewal',
        },
        {
          kind: 'credits',
          id: expect.any(String),
          date: '2026-04-01T12:00:00.000Z',
          amountMicrodollars: 9_000_000,
          description: 'Standard renewal',
        },
      ],
      hasMore: false,
      cursor: null,
    });
  });

  it('creates a customer portal session for the requested Stripe-funded instance', async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/kiloclaw-portal',
    });

    const instance = await createInstanceRow({ userId: user.id, name: 'Portal Instance' });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_kiloclaw_portal',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getCustomerPortalUrl({
      instanceId: instance.id,
      returnUrl: 'https://example.test/subscriptions/kiloclaw',
    });

    expect(result).toEqual({ url: 'https://stripe.example.test/kiloclaw-portal' });
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: user.stripe_customer_id,
      return_url: 'https://example.test/subscriptions/kiloclaw',
    });
  });

  it('cancels only the targeted instance subscription', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const targetInstance = await createInstanceRow({ userId: user.id, name: 'Target Instance' });
    const otherInstance = await createInstanceRow({ userId: user.id, name: 'Other Instance' });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: targetInstance.id,
      stripeSubscriptionId: 'sub_target_instance',
      plan: 'standard',
      status: 'active',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: otherInstance.id,
      stripeSubscriptionId: 'sub_other_instance',
      plan: 'commit',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscriptionAtInstance({
      instanceId: targetInstance.id,
    });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_target_instance', {
      cancel_at_period_end: true,
    });

    const [targetRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, targetInstance.id))
      .limit(1);
    const [otherRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, otherInstance.id))
      .limit(1);

    expect(targetRow.cancel_at_period_end).toBe(true);
    expect(otherRow.cancel_at_period_end).toBe(false);
  });
});

describe('createSubscriptionCheckout', () => {
  it('uses the intro price and allow_promotion_codes for new standard subscribers', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // Should use intro price
    expect(callArgs.line_items).toEqual([{ price: 'price_standard_intro', quantity: 1 }]);
    // Should allow promotion codes on hosted checkout.
    expect(callArgs.allow_promotion_codes).toBe(true);
    // Should NOT have discounts (coupon removed)
    expect(callArgs.discounts).toBeUndefined();
  });

  it('uses the regular price for returning canceled standard subscribers', async () => {
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
    // Should use regular price (via getStripePriceIdForClawPlan mock which returns 'price_test_kiloclaw')
    expect(callArgs.line_items).toEqual([{ price: 'price_test_kiloclaw', quantity: 1 }]);
    expect(callArgs.allow_promotion_codes).toBe(true);
    expect(callArgs.discounts).toBeUndefined();
  });

  it('uses the intro price for users whose trial expired without a paid subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'trial',
      status: 'canceled',
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
    // A canceled trial is not a prior paid subscription — should get intro price
    expect(callArgs.line_items).toEqual([{ price: 'price_standard_intro', quantity: 1 }]);
  });

  it('uses allow_promotion_codes for commit plan', async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'commit' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.allow_promotion_codes).toBe(true);
    expect(callArgs.discounts).toBeUndefined();
  });

  it('includes affiliateTrackingId in checkout metadata when attribution exists', async () => {
    await db.insert(user_affiliate_attributions).values({
      user_id: user.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: {
          metadata: {
            type: 'kiloclaw',
            plan: 'standard',
            kiloUserId: user.id,
            affiliateTrackingId: 'impact-click-123',
          },
        },
        metadata: {
          type: 'kiloclaw',
          plan: 'standard',
          kiloUserId: user.id,
          affiliateTrackingId: 'impact-click-123',
        },
      })
    );
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
    // User has a trial row (stripe_subscription_id is null) — must have an
    // instance so the upsert ON CONFLICT (instance_id) path can match it.
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
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

  it('enqueues trial_end affiliate events when a Stripe subscription upgrades a delivered trial', async () => {
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const subscription = makeStripeSubscription({
      id: 'sub_affiliate_trial_upgrade',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_affiliate_trial_upgrade',
      subscription,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
      })
    );
  });

  it('enqueues trial_end from persisted trial history when the paid row is already active', async () => {
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
    jest.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    const trialStartedAt = '2026-04-01T00:00:00.000Z';
    const trialEndsAt = '2026-04-08T00:00:00.000Z';
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_affiliate_trial_upgrade_retry',
      plan: 'standard',
      status: 'active',
      trial_started_at: trialStartedAt,
      trial_ends_at: trialEndsAt,
      current_period_start: trialEndsAt,
      current_period_end: '2026-05-08T00:00:00.000Z',
    });

    const subscriptionCreatedAt = Math.floor(new Date('2026-04-09T10:15:00.000Z').getTime() / 1000);
    const subscription = makeStripeSubscription({
      id: 'sub_affiliate_trial_upgrade_retry',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
      created: subscriptionCreatedAt,
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_affiliate_trial_upgrade_retry',
      subscription,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          eventDate: '2026-04-09T10:15:00.000Z',
          orderId: 'IR_AN_64_TS',
        }),
      })
    );

    jest.useRealTimers();
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

  it('calls ensureAutoIntroSchedule for intro-price subscription', async () => {
    // Set up stripe.subscriptions.retrieve to return intro price
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_auto',
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const subscription = makeStripeSubscription({
      id: 'sub_intro',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard_intro',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_intro_created',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_intro');
    expect(row.plan).toBe('standard');
    // ensureAutoIntroSchedule should have been invoked
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
    expect(row.stripe_schedule_id).toBe('sub_sched_auto');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('auto');
  });

  it('repairs half-configured auto-intro schedule on retry', async () => {
    // Simulate: first attempt created the schedule (from_subscription) and tagged
    // it auto-intro, but the 2-phase rewrite never completed. On retry, the
    // subscription has a schedule attached with auto-intro metadata but only 1 phase.
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_half',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_half',
      metadata: { origin: 'auto-intro' },
      // Only 1 phase — the 2-phase rewrite never completed
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const subscription = makeStripeSubscription({
      id: 'sub_half_repair',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard_intro',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_half_repair',
      subscription,
    });

    // Should have rewritten the schedule with 2 phases
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sched_half',
      expect.objectContaining({
        end_behavior: 'release',
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: [{ price: 'price_standard_intro' }],
          }),
          expect.objectContaining({
            items: [{ price: 'price_test_kiloclaw' }],
          }),
        ]),
      })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBe('sched_half');
    expect(row.scheduled_by).toBe('auto');
  });

  it('does not create auto schedule for regular-price subscription (returning subscriber)', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_old_canceled',
    });

    // Regular price — isIntroPriceId returns false
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const subscription = makeStripeSubscription({
      id: 'sub_regular_return',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_regular_created',
      subscription,
    });

    // Should NOT create a schedule
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('does not attach a personal subscription to an org-owned instance', async () => {
    const organization = await createOrganization('Org Webhook Test', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    const subscription = makeStripeSubscription({
      id: 'sub_personal_checkout',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_org_scope_test',
      subscription,
    });

    // The subscription should be inserted with instance_id = NULL (no personal
    // instance available), not attached to the org instance.
    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, 'sub_personal_checkout'));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.instance_id).toBeNull();
    expect(rows[0]!.instance_id).not.toBe(orgInstance.id);
  });
});

describe('handleKiloClawInvoicePaid affiliate events', () => {
  let handleKiloClawInvoicePaid: (params: {
    eventId: string;
    invoice: Stripe.Invoice;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawInvoicePaid = mod.handleKiloClawInvoicePaid;
  });

  it('enqueues sale affiliate events for delivered attributed users', async () => {
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_invoice_paid',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_invoice_paid_affiliate',
      invoice: {
        id: 'in_affiliate_sale',
        amount_paid: 900,
        currency: 'usd',
        charge: 'ch_affiliate_sale',
        parent: {
          subscription_details: {
            subscription: 'sub_invoice_paid',
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(new Date('2026-04-09T10:00:00.000Z').getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup']);
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard',
          itemName: 'KiloClaw Standard Plan',
          orderId: 'in_affiliate_sale',
        }),
      })
    );
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

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
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

  it('cancels the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_effective_cancel',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_effective_cancel', {
      cancel_at_period_end: true,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.cancel_at_period_end).toBe(true);
    expect(unchangedTrial?.cancel_at_period_end).toBe(false);
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

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
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

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
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

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
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

  it('detects and releases hidden schedule when DB has no pointer but Stripe has schedule', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_hidden_sched',
      plan: 'standard',
      status: 'active',
      // No stripe_schedule_id in DB
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_hidden');
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

  it('restores auto intro schedule after reactivating a standard intro-price subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_reactivate_intro',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    // ensureAutoIntroSchedule will call stripe.subscriptions.retrieve
    // Return intro price to trigger schedule creation
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_restored',
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    // Schedule should have been created
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('reactivates the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_reactivate_effective',
      paidCancelAtPeriodEnd: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_reactivate_effective', {
      cancel_at_period_end: false,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.cancel_at_period_end).toBe(false);
    expect(unchangedTrial?.cancel_at_period_end).toBe(false);
  });

  it('succeeds even if ensureAutoIntroSchedule throws after reactivation', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_reactivate_fail',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    // Make ensureAutoIntroSchedule fail
    stripeMock.subscriptions.retrieve.mockRejectedValue(new Error('Stripe timeout'));

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    // Should still succeed — reactivation is the primary operation
    expect(result).toEqual({ success: true });
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('rejects when the user has no subscriptions', async () => {
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.reactivateSubscription()).rejects.toThrow(
      'No pending cancellation to reactivate.'
    );
  });
});

describe('switchPlan', () => {
  it('creates a fresh schedule when switching standard to commit with no existing schedule', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_switch',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalled();

    const [dbRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(dbRow.stripe_schedule_id).toBe('sub_sched_new');
    expect(dbRow.scheduled_plan).toBe('commit');
    expect(dbRow.scheduled_by).toBe('user');
  });

  it('switches the effective paid subscription when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_switch_effective',
      paidPlan: 'standard',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_effective',
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_effective',
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.stripe_schedule_id).toBe('sub_sched_effective');
    expect(updatedPaid?.scheduled_plan).toBe('commit');
    expect(updatedPaid?.scheduled_by).toBe('user');
    expect(unchangedTrial?.scheduled_plan).toBeNull();
  });

  it('rejects switch when user-initiated schedule already exists', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_switch_reject',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_pending',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_user_pending',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'A plan switch is already pending'
    );
  });

  it('updates auto schedule in place when switching standard (intro) to commit', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_switch_auto',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_auto',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_auto',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_auto',
      metadata: { origin: 'auto-intro' },
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    // Should update existing schedule, not create a new one
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sched_auto',
      expect.objectContaining({
        end_behavior: 'release',
      })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBe('sched_auto');
    expect(row.scheduled_plan).toBe('commit');
    expect(row.scheduled_by).toBe('user');
  });

  it('detects hidden auto schedule via live fetch and updates it in place', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_hidden_auto',
      plan: 'standard',
      status: 'active',
      // No stripe_schedule_id in DB
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_auto',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_auto',
      metadata: { origin: 'auto-intro' },
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.scheduled_by).toBe('user');
    expect(row.scheduled_plan).toBe('commit');
  });

  it('releases hidden non-auto schedule and creates fresh schedule', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_hidden_user',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_user',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_user',
      metadata: {},
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_fresh',
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_hidden_user');
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('rejects switch to same plan', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_same',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Already on this plan'
    );
  });

  it('aborts when releasing hidden non-auto schedule fails with transient error', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_hidden_fail',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_hidden_transient',
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_hidden_transient',
      metadata: {},
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
      status: 'active',
    });
    // Transient error — not "not active" or "released" or "canceled"
    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe API timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'Unable to switch plan: failed to release existing schedule'
    );
  });

  it('derives phase-1 price from the newly created schedule, not the stale live fetch', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_fresh_price',
      plan: 'standard',
      status: 'active',
    });

    // Live fetch returns the old intro price (stale by the time the schedule is created)
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    // But from_subscription mirrors the subscription's current state at create time,
    // which has already rolled over to the regular price
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_fresh_price',
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    // Phase 1 should use the fresh price from the schedule ('price_standard'),
    // not the stale intro price from the earlier subscriptions.retrieve()
    const updateArgs = stripeMock.subscriptionSchedules.update.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    const phases = updateArgs.phases as Array<{ items: Array<{ price: string }> }>;
    expect(phases[0].items[0].price).toBe('price_standard');
  });
});

describe('cancelPlanSwitch', () => {
  it('releases user schedule and clears DB fields', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_cancel_switch',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_switch',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    // ensureAutoIntroSchedule will check price — return regular price so it no-ops
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_user_switch');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });

  it('cancels the effective paid plan switch when a canceled trial also exists', async () => {
    const { paidSubscription, trialSubscription } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_cancel_switch_effective',
      paidStripeScheduleId: 'sched_effective_user_switch',
      paidScheduledPlan: 'commit',
      paidScheduledBy: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sched_effective_user_switch'
    );

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPaid = rows.find(row => row.id === paidSubscription.id);
    const unchangedTrial = rows.find(row => row.id === trialSubscription.id);

    expect(updatedPaid?.stripe_schedule_id).toBeNull();
    expect(updatedPaid?.scheduled_plan).toBeNull();
    expect(updatedPaid?.scheduled_by).toBeNull();
    expect(unchangedTrial?.scheduled_plan).toBeNull();
  });

  it('restores auto schedule when canceling switch during intro month', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_cancel_switch_intro',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_user_intro',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    // Return intro price so ensureAutoIntroSchedule creates a schedule
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sched_auto_restored',
      phases: [{ items: [{ price: 'price_standard_intro' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    // Should have restored the auto schedule
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    // After ensureAutoIntroSchedule, DB should have the restored schedule
    expect(row.stripe_schedule_id).toBe('sched_auto_restored');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('auto');
  });

  it('rejects when no user-initiated schedule exists', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_no_switch',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_auto_only',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No user-initiated plan switch to cancel'
    );
  });

  it('succeeds when schedule is already released', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_already_released',
      plan: 'standard',
      status: 'active',
      stripe_schedule_id: 'sched_gone',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(
      new Error('This schedule is not active and cannot be released')
    );
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
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

  it('rejects when a canceled trial and an active paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_checkout_blocked',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when a canceled trial and a past-due paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStatus: 'past_due',
      paidStripeSubscriptionId: 'sub_checkout_past_due',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when a canceled trial and an unpaid paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStatus: 'unpaid',
      paidStripeSubscriptionId: 'sub_checkout_unpaid',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('does not block personal checkout when only an org-backed subscription is active', async () => {
    const organization = await createOrganization('Org Checkout Test', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: orgInstance.id,
      stripe_subscription_id: 'sub_org_active',
      plan: 'standard',
      status: 'active',
    });

    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_personal',
      url: 'https://checkout.stripe.com/personal',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/personal' });
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });
});

// ── org-subscription coexistence ──────────────────────────────────────────

describe('personal billing mutations do not affect org subscriptions', () => {
  async function createPersonalAndOrgSubscriptions(overrides?: {
    personalCancelAtPeriodEnd?: boolean;
    personalScheduledPlan?: 'standard' | 'commit';
    personalScheduledBy?: 'user' | 'auto';
    personalStripeScheduleId?: string;
  }) {
    const organization = await createOrganization('Org Coexistence', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    const personalInstance = await createKiloclawInstance(user.id);

    const [orgSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: orgInstance.id,
        stripe_subscription_id: 'sub_org_coexist',
        plan: 'standard',
        status: 'active',
        current_period_end: '2026-06-01T00:00:00.000Z',
      })
      .returning();

    const [personalSub] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: personalInstance.id,
        stripe_subscription_id: 'sub_personal_coexist',
        plan: 'standard',
        status: 'active',
        cancel_at_period_end: overrides?.personalCancelAtPeriodEnd ?? false,
        stripe_schedule_id: overrides?.personalStripeScheduleId,
        scheduled_plan: overrides?.personalScheduledPlan,
        scheduled_by: overrides?.personalScheduledBy,
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    return { orgInstance, personalInstance, orgSub: orgSub!, personalSub: personalSub! };
  }

  it('cancelSubscription targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions();

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_personal_coexist', {
      cancel_at_period_end: true,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.cancel_at_period_end).toBe(true);
    expect(unchangedOrg?.cancel_at_period_end).toBe(false);
  });

  it('reactivateSubscription targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions({
      personalCancelAtPeriodEnd: true,
    });

    stripeMock.subscriptions.update.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_personal_coexist', {
      cancel_at_period_end: false,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.cancel_at_period_end).toBe(false);
    expect(unchangedOrg?.cancel_at_period_end).toBe(false);
  });

  it('switchPlan targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions();

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_personal',
      phases: [{ items: [{ price: 'price_standard' }], start_date: 1000, end_date: 2000 }],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_personal_coexist',
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.scheduled_plan).toBe('commit');
    expect(unchangedOrg?.scheduled_plan).toBeNull();
  });

  it('cancelPlanSwitch targets the personal subscription, not the org one', async () => {
    const { orgSub, personalSub } = await createPersonalAndOrgSubscriptions({
      personalStripeScheduleId: 'sched_personal_switch',
      personalScheduledPlan: 'commit',
      personalScheduledBy: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_personal_switch');

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPersonal = rows.find(row => row.id === personalSub.id);
    const unchangedOrg = rows.find(row => row.id === orgSub.id);

    expect(updatedPersonal?.stripe_schedule_id).toBeNull();
    expect(updatedPersonal?.scheduled_plan).toBeNull();
    expect(unchangedOrg?.scheduled_plan).toBeNull();
  });
});

// ── switchPlan ─────────────────────────────────────────────────────────────

describe('switchPlan', () => {
  const now = Math.floor(Date.now() / 1000);

  function setupActiveSubscription(plan: 'commit' | 'standard') {
    return db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_switch_test',
      plan,
      status: 'active',
    });
  }

  function mockStripeForSwitchPlan(scheduleOnSub: string | null = null) {
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: scheduleOnSub,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [
        { start_date: now, end_date: now + 86400 * 30, items: [{ price: 'price_test_kiloclaw' }] },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({
      id: 'sub_sched_new',
      status: 'active',
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
  }

  it('creates a schedule and writes it to the DB on happy path', async () => {
    await setupActiveSubscription('commit');
    mockStripeForSwitchPlan();

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_test',
    });
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sub_sched_new',
      expect.objectContaining({ end_behavior: 'release' })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_new');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('user');
  });

  it('rejects when user is already on the target plan', async () => {
    await setupActiveSubscription('standard');
    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Already on this plan'
    );
  });

  it('rejects when subscription is not active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_canceled',
      plan: 'standard',
      status: 'canceled',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'No active subscription to switch'
    );
  });

  it('rejects when a pending plan switch already exists in the DB', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_switch_test',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_existing',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'A plan switch is already pending'
    );

    // Should NOT have created or released anything on Stripe
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('releases an orphaned Stripe schedule not tracked in the DB', async () => {
    await setupActiveSubscription('commit');
    // DB has no stripe_schedule_id, but Stripe has an orphaned schedule attached
    mockStripeForSwitchPlan('sub_sched_orphaned');

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    // Should have released the orphaned schedule first, then created a new one
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_orphaned');
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalledWith({
      from_subscription: 'sub_switch_test',
    });
  });

  it('aborts when orphaned schedule release fails with a transient error', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: 'sub_sched_orphaned',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe network timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Unable to switch plan: failed to release existing schedule'
    );

    // Should NOT have attempted to create a new schedule
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('proceeds when orphaned schedule release says already released', async () => {
    await setupActiveSubscription('commit');

    const alreadyReleasedError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been released',
      type: 'invalid_request_error',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: 'sub_sched_orphaned',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValueOnce(alreadyReleasedError);
    // Subsequent release calls (cleanup) succeed
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_new',
      phases: [
        { start_date: now, end_date: now + 86400 * 30, items: [{ price: 'price_test_kiloclaw' }] },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({
      id: 'sub_sched_new',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'standard' });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
  });

  it('cleans up orphaned schedule when stripe schedule update fails', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: null,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_orphan',
      phases: [
        { start_date: now, end_date: now + 86400 * 30, items: [{ price: 'price_test_kiloclaw' }] },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockRejectedValue(new Error('Stripe update failed'));
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'Stripe update failed'
    );

    // Best-effort cleanup should have released the orphaned schedule
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_orphan');

    // DB should NOT have been updated with the orphaned schedule
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
  });

  it('uses optimistic concurrency to prevent double-write race', async () => {
    await setupActiveSubscription('commit');

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_switch_test',
      schedule: null,
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_race',
      phases: [
        { start_date: now, end_date: now + 86400 * 30, items: [{ price: 'price_test_kiloclaw' }] },
      ],
    });
    // Simulate a concurrent request writing a schedule to the DB while our
    // Stripe schedule update is in-flight — after the DB guard passed but
    // before our optimistic DB write.
    stripeMock.subscriptionSchedules.update.mockImplementation(async () => {
      await db
        .update(kiloclaw_subscriptions)
        .set({
          stripe_schedule_id: 'sub_sched_concurrent',
          scheduled_plan: 'standard',
          scheduled_by: 'user',
        })
        .where(eq(kiloclaw_subscriptions.user_id, user.id));
      return { id: 'sub_sched_race', status: 'active' };
    });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'standard' })).rejects.toThrow(
      'A plan switch is already pending'
    );

    // Should have released the schedule it created since the DB write lost the race
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_race');

    // DB should still have the concurrent request's schedule
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_concurrent');
  });
});

// ── cancelPlanSwitch ───────────────────────────────────────────────────────

describe('cancelPlanSwitch', () => {
  it('releases the schedule and clears DB fields on happy path', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_cancel_test',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_cancel',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_cancel');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });

  it('rejects when no pending plan switch exists', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_no_schedule',
      plan: 'commit',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No pending plan switch to cancel'
    );
  });

  it('rejects when the pending switch was not user-initiated', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_system_switch',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_system',
      scheduled_plan: 'standard',
      scheduled_by: 'auto',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'No user-initiated plan switch to cancel'
    );
  });

  it('clears DB when Stripe says schedule is already released', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_already_released',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_gone',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const alreadyReleasedError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been released',
      type: 'invalid_request_error',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(alreadyReleasedError);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('clears DB when Stripe says schedule is already canceled', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_already_canceled',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_canceled',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    const alreadyCanceledError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'This schedule has already been canceled',
      type: 'invalid_request_error',
    });
    stripeMock.subscriptionSchedules.release.mockRejectedValue(alreadyCanceledError);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('rethrows non-already-released Stripe errors', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_stripe_fail',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sub_sched_fail',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });

    stripeMock.subscriptionSchedules.release.mockRejectedValue(new Error('Stripe network timeout'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.cancelPlanSwitch()).rejects.toThrow(
      'Failed to release pending plan schedule'
    );

    // DB should NOT have been cleared since Stripe failed
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_schedule_id).toBe('sub_sched_fail');
  });
});

// ── Credit Enrollment ──────────────────────────────────────────────────────

describe('enrollWithCredits', () => {
  async function giveUserCredits(userId: string, microdollars: number) {
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: microdollars })
      .where(eq(kilocode_users.id, userId));
  }

  async function createInstance(userId: string) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: userId,
        sandbox_id: sandboxIdFromUserId(userId),
      })
      .returning();
    return instance;
  }

  it('enrolls with credits for standard plan at intro price for first-time subscriber', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000); // $50

    // Create a trialing subscription — trial does not count as a prior paid sub,
    // so the user qualifies for the $4 first-month discount.
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.status).toBe('active');
    expect(sub.payment_source).toBe('credits');
    expect(sub.plan).toBe('standard');
    expect(sub.stripe_subscription_id).toBeNull();
    expect(sub.credit_renewal_at).not.toBeNull();
    expect(sub.cancel_at_period_end).toBe(false);
    // Trial dates are preserved for historical visibility in billing status / admin views
    expect(sub.trial_started_at).not.toBeNull();
    expect(sub.trial_ends_at).not.toBeNull();

    // Verify credit deduction at intro price ($4, not $9)
    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction).toBeDefined();
    expect(deduction!.amount_microdollars).toBe(-4_000_000);
    expect(deduction!.credit_category).toContain('kiloclaw-subscription:');

    // Verify credit spend recorded at intro amount
    const [updatedUser] = await db
      .select({
        acquired: kilocode_users.total_microdollars_acquired,
        used: kilocode_users.microdollars_used,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);

    expect(updatedUser.acquired).toBe(50_000_000);
    expect(updatedUser.used).toBe(4_000_000);
  });

  it('enrolls with credits for commit plan when balance sufficient', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000); // $50

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'commit' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.plan).toBe('commit');
    expect(sub.status).toBe('active');
    expect(sub.payment_source).toBe('credits');
    expect(sub.commit_ends_at).not.toBeNull();

    // commit_ends_at should be ~6 months from now
    const commitEnd = new Date(sub.commit_ends_at!);
    const diffDays = (commitEnd.getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThanOrEqual(178);
    expect(diffDays).toBeLessThanOrEqual(184);
  });

  it('rejects enrollment when balance is insufficient', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 5_000_000); // $5 — not enough for commit ($48)

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'commit' })).rejects.toThrow(
      'Insufficient credit balance'
    );
  });

  it('rejects enrollment when subscription is active', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'active subscription already exists'
    );
  });

  it('enrolls returning subscriber at full price for standard plan', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    // A canceled non-trial subscription means this is a returning subscriber
    // who should pay the full $9 price, not the $4 intro price.
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.status).toBe('active');
    expect(sub.payment_source).toBe('credits');

    // Verify full price deduction ($9, not $4)
    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction).toBeDefined();
    expect(deduction!.amount_microdollars).toBe(-9_000_000);

    const [updatedUser] = await db
      .select({ used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);

    expect(updatedUser.used).toBe(9_000_000);
  });

  it('allows enrollment when subscription is trialing', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    expect(result).toEqual({ success: true });

    const [sub] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(sub.status).toBe('active');
    expect(sub.plan).toBe('standard');
    // Trial dates are preserved for historical visibility
    expect(sub.trial_started_at).not.toBeNull();
    expect(sub.trial_ends_at).not.toBeNull();
  });

  it('enqueues trial_end and sale affiliate events for attributed trial-to-credit conversion', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
      })
    );
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 4,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'price_standard_intro',
          orderId: expect.stringContaining(`kiloclaw-subscription:${instance.id}:`),
        }),
      })
    );
  });

  it('enqueues only sale affiliate events for attributed direct credit enrollment', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'commit' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup']);
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 48,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-commit',
          itemName: 'KiloClaw Commit Plan',
          itemSku: 'price_test_kiloclaw',
          orderId: expect.stringContaining(`kiloclaw-subscription-commit:${instance.id}:`),
        }),
      })
    );
  });

  it('does not enqueue affiliate child events for non-attributed credit enrollment', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events).toHaveLength(0);
  });

  it('applies intro price for canceled-trial subscriber', async () => {
    const instance = await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    // Canceled trial does not count as a prior paid subscription
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    expect(result).toEqual({ success: true });

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction!.amount_microdollars).toBe(-4_000_000);
  });

  it('succeeds with balance between intro and full price for first-time subscriber', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 5_000_000); // $5 — enough for $4 intro, not enough for $9

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    expect(result).toEqual({ success: true });

    const txns = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    const deduction = txns.find(t => t.amount_microdollars < 0);
    expect(deduction!.amount_microdollars).toBe(-4_000_000);
  });

  it('rejects first-time standard enrollment when balance insufficient for intro price', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 3_000_000); // $3 — not enough for $4 intro

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Insufficient credit balance'
    );
  });

  it('deduction is idempotent via credit_category uniqueness', async () => {
    await createInstance(user.id);
    await giveUserCredits(user.id, 50_000_000);

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.enrollWithCredits({ plan: 'standard' });

    // Second enrollment in the same period should fail
    // Reset subscription status so the enrollment guard doesn't reject first
    await db
      .update(kiloclaw_subscriptions)
      .set({ status: 'canceled' })
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    // Re-fetch user balance (it was decremented by first enrollment)
    await giveUserCredits(user.id, 50_000_000);

    await expect(caller.kiloclaw.enrollWithCredits({ plan: 'standard' })).rejects.toThrow(
      'Enrollment already processed for this billing period'
    );
  });
});

// ── Billing Status with Credits ────────────────────────────────────────────

describe('getBillingStatus with credits', () => {
  async function createKiloPassSubscription(params: {
    userId: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd?: boolean;
    endedAt?: string | null;
  }) {
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: params.userId,
      stripe_subscription_id: `kp-stripe-sub-${crypto.randomUUID()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: params.status,
      cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
      started_at: new Date().toISOString(),
      ended_at: params.endedAt ?? null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });
  }

  it('includes hasStripeFunding=true for Stripe-funded subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_stripe_funded',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(true);
  });

  it('includes hasStripeFunding=false for pure credit subscription', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(false);
  });

  it('includes credit balance in response', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(typeof result.creditBalanceMicrodollars).toBe('number');
  });

  it('reports pure credit subscription data (not suppressed)', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.plan).toBe('standard');
    expect(result.subscription!.status).toBe('active');
    expect(result.subscription!.paymentSource).toBe('credits');
    expect(result.subscription!.creditRenewalAt).not.toBeNull();
    expect(result.subscription!.renewalCostMicrodollars).toBe(9_000_000);
  });

  it('reports creditIntroEligible=true for new user with no subscription', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=true for trialing user', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=false for returning subscriber', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(false);
  });

  it('reports hasActiveKiloPass=true for a non-ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(true);
  });

  it('reports hasActiveKiloPass=false for an ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(false);
  });

  it('includes plan-specific effective balance previews with projected Kilo Pass bonus', async () => {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 0,
        microdollars_used: 0,
        kilo_pass_threshold: 4_000_000,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      stripe_subscription_id: `kp-stripe-sub-${crypto.randomUUID()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditEnrollmentPreview.standard.costMicrodollars).toBe(4_000_000);
    expect(result.creditEnrollmentPreview.standard.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.standard.effectiveBalanceMicrodollars).toBe(9_500_000);

    expect(result.creditEnrollmentPreview.commit.costMicrodollars).toBe(48_000_000);
    expect(result.creditEnrollmentPreview.commit.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.commit.effectiveBalanceMicrodollars).toBe(9_500_000);
  });
});

// ── Pure Credit Cancel/Reactivate/SwitchPlan/CancelPlanSwitch ──────────────

describe('pure credit cancel/reactivate', () => {
  async function createPureCreditSubscription(
    userId: string,
    plan: 'standard' | 'commit' = 'standard',
    overrides: Record<string, unknown> = {}
  ) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: userId, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: userId,
      instance_id: instance.id,
      payment_source: 'credits',
      plan,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
      ...overrides,
    });

    return instance;
  }

  it('cancels pure credit subscription without Stripe API call', async () => {
    await createPureCreditSubscription(user.id);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscription();

    expect(result).toEqual({ success: true });

    // No Stripe calls should have been made
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    // Schedule fields should be cleared defensively
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });

  it('reactivates pure credit subscription without Stripe API call', async () => {
    await createPureCreditSubscription(user.id, 'standard', {
      cancel_at_period_end: true,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.reactivateSubscription();

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(false);
  });

  it('switches plan for pure credit subscription locally', async () => {
    await createPureCreditSubscription(user.id, 'standard');

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.switchPlan({ toPlan: 'commit' });

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripeMock.subscriptionSchedules.update).not.toHaveBeenCalled();
    expect(stripeMock.subscriptions.retrieve).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.scheduled_plan).toBe('commit');
    expect(row.scheduled_by).toBe('user');
  });

  it('cancels plan switch for pure credit subscription locally', async () => {
    await createPureCreditSubscription(user.id, 'standard', {
      scheduled_plan: 'commit',
      scheduled_by: 'user',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitch();

    expect(result).toEqual({ success: true });

    // No Stripe calls
    expect(stripeMock.subscriptionSchedules.release).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.scheduled_plan).toBeNull();
    expect(row.scheduled_by).toBeNull();
  });
});

describe('acceptConversion', () => {
  async function createActiveKiloPass(userId: string) {
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: userId,
      stripe_subscription_id: `kp-stripe-sub-${crypto.randomUUID()}`,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });
  }

  it('sets cancel_at_period_end on Stripe-funded subscription when user has active Kilo Pass', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_convert',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_convert', {
      cancel_at_period_end: true,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.pending_conversion).toBe(true);
  });

  it('releases schedule before setting cancel_at_period_end', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_convert_sched',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_conv',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_conv');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('rejects when no active Kilo Pass', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_no_kp',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('Active Kilo Pass required');
  });

  it('rejects when subscription is not Stripe-funded', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await createActiveKiloPass(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('not Stripe-funded');
  });

  it('rejects when subscription is already set to cancel', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_already_cancel',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });
    await createActiveKiloPass(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('already set to cancel');
  });

  it('rolls back pending_conversion when Stripe definitively rejects the update', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_reject',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe API error'));
    // Re-fetch confirms Stripe did NOT apply cancel_at_period_end
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ cancel_at_period_end: false });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow(
      'Failed to schedule Stripe cancellation'
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.pending_conversion).toBe(false);
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('keeps pending_conversion when Stripe update throws but re-fetch confirms cancellation applied', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_timeout',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe timeout'));
    // Re-fetch confirms Stripe DID apply cancel_at_period_end (timeout-after-commit)
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ cancel_at_period_end: true });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.pending_conversion).toBe(true);
    expect(row.cancel_at_period_end).toBe(true);
  });

  it('throws on ambiguous failure but leaves pending_conversion armed for retry safety', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_double_fail',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe timeout'));
    // Re-fetch also fails — ambiguous state
    stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow(
      'Unable to confirm Stripe cancellation'
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    // pending_conversion stays armed (Stripe may have committed)
    expect(row.pending_conversion).toBe(true);
    // cancel_at_period_end is NOT set — allows retry
    expect(row.cancel_at_period_end).toBe(false);
  });
});
