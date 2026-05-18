import { describe, test, expect, afterEach } from '@jest/globals';

import { db } from '@/lib/drizzle';
import {
  kilo_pass_audit_log,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import {
  KiloPassAuditLogAction,
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { and, eq } from 'drizzle-orm';

import { insertTestUser } from '@/tests/helpers/user.helper';
import { reconcileStoreSubscriptionExpiry } from '@/lib/kilo-pass/store-subscription-reconcile';

type InsertSubscriptionParams = {
  kiloUserId: string;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string;
  status?: 'active' | 'canceled' | 'paused';
  tier?: KiloPassTier;
  cadence?: KiloPassCadence;
  startedAt?: string;
};

async function insertStoreSubscription(params: InsertSubscriptionParams): Promise<{ id: string }> {
  const [row] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      payment_provider: params.paymentProvider,
      provider_subscription_id: params.providerSubscriptionId,
      stripe_subscription_id: null,
      tier: params.tier ?? KiloPassTier.Tier19,
      cadence: params.cadence ?? KiloPassCadence.Monthly,
      status: params.status ?? 'active',
      cancel_at_period_end: false,
      started_at: params.startedAt ?? '2026-01-01T00:00:00.000Z',
      ended_at: null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    })
    .returning({ id: kilo_pass_subscriptions.id });
  if (!row) throw new Error('Failed to insert subscription');
  return row;
}

async function insertStorePurchase(params: {
  subscriptionId: string;
  kiloUserId: string;
  appAccountToken: string;
  paymentProvider: KiloPassPaymentProvider;
  providerSubscriptionId: string;
  providerTransactionId: string;
  purchasedAt: string;
  expiresAt: string | null;
}): Promise<void> {
  await db.insert(kilo_pass_store_purchases).values({
    kilo_pass_subscription_id: params.subscriptionId,
    kilo_user_id: params.kiloUserId,
    payment_provider: params.paymentProvider,
    product_id: 'kilo_pass_tier_19_monthly',
    provider_subscription_id: params.providerSubscriptionId,
    provider_transaction_id: params.providerTransactionId,
    provider_original_transaction_id: params.providerSubscriptionId,
    app_account_token: params.appAccountToken,
    environment: 'Sandbox',
    purchased_at: params.purchasedAt,
    expires_at: params.expiresAt,
    raw_payload_json: {},
  });
}

describe('reconcileStoreSubscriptionExpiry', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_audit_log);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_store_purchases);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilo_pass_subscriptions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  test('cancels store-managed subscriptions whose latest purchase has expired', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const user = await insertTestUser({
      google_user_email: 'reconcile-expired@example.com',
    });
    const providerSubscriptionId = 'orig_reconcile_expired';
    const { id: subscriptionId } = await insertStoreSubscription({
      kiloUserId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });
    await insertStorePurchase({
      subscriptionId,
      kiloUserId: user.id,
      appAccountToken: user.app_store_account_token!,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
      providerTransactionId: 'tx_reconcile_expired',
      purchasedAt: '2026-01-31T00:00:00.000Z',
      expiresAt: '2026-02-28T00:00:00.000Z',
    });

    const summary = await reconcileStoreSubscriptionExpiry(db, { now });

    expect(summary.scannedSubscriptionCount).toBe(1);
    expect(summary.expiredSubscriptionCount).toBe(1);
    expect(summary.skippedNoStorePurchaseCount).toBe(0);

    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, subscriptionId),
    });
    expect(row).toEqual(
      expect.objectContaining({
        status: 'canceled',
        cancel_at_period_end: false,
      })
    );
    expect(new Date(row!.ended_at!).toISOString()).toBe('2026-03-01T00:00:00.000Z');

    const auditRows = await db
      .select({ id: kilo_pass_audit_log.id })
      .from(kilo_pass_audit_log)
      .where(
        and(
          eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StoreSubscriptionExpired),
          eq(kilo_pass_audit_log.kilo_pass_subscription_id, subscriptionId)
        )
      );
    expect(auditRows.length).toBe(1);
  });

  test('leaves a store subscription untouched when the latest purchase has not expired', async () => {
    const now = new Date('2026-02-15T00:00:00.000Z');
    const user = await insertTestUser({
      google_user_email: 'reconcile-future-expiry@example.com',
    });
    const providerSubscriptionId = 'orig_reconcile_future_expiry';
    const { id: subscriptionId } = await insertStoreSubscription({
      kiloUserId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });
    await insertStorePurchase({
      subscriptionId,
      kiloUserId: user.id,
      appAccountToken: user.app_store_account_token!,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
      providerTransactionId: 'tx_reconcile_future_expiry',
      purchasedAt: '2026-02-01T00:00:00.000Z',
      expiresAt: '2026-03-01T00:00:00.000Z',
    });

    const summary = await reconcileStoreSubscriptionExpiry(db, { now });

    expect(summary.expiredSubscriptionCount).toBe(0);

    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, subscriptionId),
    });
    expect(row).toEqual(
      expect.objectContaining({
        status: 'active',
        ended_at: null,
      })
    );
  });

  test('skips subscriptions that are already canceled', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const user = await insertTestUser({
      google_user_email: 'reconcile-already-canceled@example.com',
    });
    const providerSubscriptionId = 'orig_reconcile_already_canceled';
    const [row] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        provider_subscription_id: providerSubscriptionId,
        stripe_subscription_id: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'canceled',
        cancel_at_period_end: false,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-02-01T00:00:00.000Z',
        current_streak_months: 1,
        next_yearly_issue_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });
    const subscriptionId = row!.id;
    await insertStorePurchase({
      subscriptionId,
      kiloUserId: user.id,
      appAccountToken: user.app_store_account_token!,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
      providerTransactionId: 'tx_reconcile_already_canceled',
      purchasedAt: '2026-01-15T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
    });

    const summary = await reconcileStoreSubscriptionExpiry(db, { now });

    expect(summary.scannedSubscriptionCount).toBe(0);
    expect(summary.expiredSubscriptionCount).toBe(0);

    const after = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, subscriptionId),
    });
    expect(new Date(after!.ended_at!).toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  test('skips Stripe subscriptions', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const user = await insertTestUser({
      google_user_email: 'reconcile-stripe@example.com',
    });
    const stripeSubId = `test-stripe-sub-${crypto.randomUUID()}`;
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: stripeSubId,
      stripe_subscription_id: stripeSubId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const summary = await reconcileStoreSubscriptionExpiry(db, { now });

    expect(summary.scannedSubscriptionCount).toBe(0);
    expect(summary.expiredSubscriptionCount).toBe(0);
  });

  test('skips store subscriptions with no store purchase rows', async () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const user = await insertTestUser({
      google_user_email: 'reconcile-no-purchase@example.com',
    });
    await insertStoreSubscription({
      kiloUserId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId: 'orig_reconcile_no_purchase',
    });

    const summary = await reconcileStoreSubscriptionExpiry(db, { now });

    expect(summary.scannedSubscriptionCount).toBe(1);
    expect(summary.expiredSubscriptionCount).toBe(0);
    expect(summary.skippedNoStorePurchaseCount).toBe(1);
  });
});
