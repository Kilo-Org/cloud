import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';
import type Stripe from 'stripe';

import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kilo_pass_store_purchases, kilo_pass_subscriptions } from '@kilocode/db/schema';
import { KiloPassCadence, KiloPassPaymentProvider, KiloPassTier } from '@/lib/kilo-pass/enums';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cancelAndRefundKiloPassForUser } from '@/lib/kilo-pass/cancel-and-refund';

// ── Stripe mock ───────────────────────────────────────────────────────────────

jest.mock('@/lib/stripe-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { errors } = require('stripe').default ?? require('stripe');
  const stripeMock = {
    subscriptions: {
      cancel: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    subscriptionSchedules: {
      release: jest.fn(),
    },
    invoices: {
      list: jest.fn(),
    },
    invoicePayments: {
      list: jest.fn(),
    },
    refunds: {
      create: jest.fn(),
    },
    errors,
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

type AnyMock = ReturnType<typeof jest.fn>;
type StripeMock = {
  subscriptions: { cancel: AnyMock; retrieve: AnyMock; update: AnyMock };
  subscriptionSchedules: { release: AnyMock };
  invoices: { list: AnyMock };
  invoicePayments: { list: AnyMock };
  refunds: { create: AnyMock };
  errors: Stripe['errors'];
};

function getStripeMock(): StripeMock {
  const mod: { __stripeMock: StripeMock } = jest.requireMock('@/lib/stripe-client');
  return mod.__stripeMock;
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function insertActiveAppStoreSubscription(kiloUserId: string) {
  const providerSubscriptionId = `apple-orig-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const [row] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: kiloUserId,
      payment_provider: KiloPassPaymentProvider.AppStore,
      provider_subscription_id: providerSubscriptionId,
      stripe_subscription_id: null,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      current_streak_months: 1,
      started_at: now,
      ended_at: null,
      next_yearly_issue_at: null,
    })
    .returning({ id: kilo_pass_subscriptions.id });

  const subscriptionId = row!.id;

  // Insert a store purchase with a future expiry so getKiloPassStateForUser
  // does NOT mark it expired.
  await db.insert(kilo_pass_store_purchases).values({
    kilo_pass_subscription_id: subscriptionId,
    kilo_user_id: kiloUserId,
    payment_provider: KiloPassPaymentProvider.AppStore,
    product_id: 'kilopass.tier19.monthly.v1',
    provider_subscription_id: providerSubscriptionId,
    provider_transaction_id: `tx-${crypto.randomUUID()}`,
    provider_original_transaction_id: providerSubscriptionId,
    environment: 'Sandbox',
    purchased_at: now,
    expires_at: futureExpiry,
    raw_payload_json: {},
  });

  return { subscriptionId, providerSubscriptionId };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cancelAndRefundKiloPassForUser', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    const stripeMock = getStripeMock();
    stripeMock.subscriptions.cancel.mockReset();
    stripeMock.subscriptions.retrieve.mockReset();
    stripeMock.subscriptions.update.mockReset();
    stripeMock.subscriptionSchedules.release.mockReset();
    stripeMock.invoices.list.mockReset();
    stripeMock.invoicePayments.list.mockReset();
    stripeMock.refunds.create.mockReset();
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  it('returns store_managed_subscription for an active App Store subscription without calling Stripe', async () => {
    const stripeMock = getStripeMock();
    const user = await insertTestUser({
      google_user_email: 'apple-sub-user@example.com',
    });
    const { subscriptionId } = await insertActiveAppStoreSubscription(user.id);

    const result = await cancelAndRefundKiloPassForUser({
      db,
      stripe: stripeMock as unknown as Parameters<
        typeof cancelAndRefundKiloPassForUser
      >[0]['stripe'],
      userId: user.id,
      reason: 'test-reason',
      adminKiloUserId: user.id,
    });

    // Status must be skipped with the new reason kind
    expect(result.status).toBe('skipped');
    if (result.status !== 'skipped') throw new Error('unreachable');
    expect(result.reason.kind).toBe('store_managed_subscription');
    if (result.reason.kind !== 'store_managed_subscription') throw new Error('unreachable');
    expect(result.reason.paymentProvider).toBe('apple');

    // Stripe must not have been touched
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();

    // Subscription row must be untouched
    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, subscriptionId),
    });
    expect(subRow?.status).toBe('active');
    expect(subRow?.ended_at).toBeNull();
  });
});
