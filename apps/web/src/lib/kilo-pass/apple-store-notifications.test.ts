import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  Subtype,
} from '@apple/app-store-server-library';
import { and, eq } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
  KiloPassPaymentProvider,
  KiloPassTier,
} from './enums';
import { processAppStoreKiloPassNotification } from './apple-store-notifications';
import type { AppleStoreDecodedNotification } from './apple-store-notifications';
import type { AppleStoreDecodedTransaction } from './apple-store-verifier';
import { toMicrodollars } from '@/lib/utils';

const APP_STORE_NOTIFICATION_TEST_NOW_MS = Date.parse('2026-05-15T00:00:00.000Z');

function notification(
  overrides: Partial<AppleStoreDecodedNotification> = {}
): AppleStoreDecodedNotification {
  return {
    notificationUUID: `note-${crypto.randomUUID()}`,
    notificationType: NotificationTypeV2.DID_RENEW,
    environment: 'Sandbox',
    signedTransactionInfo: 'signed-transaction',
    ...overrides,
  };
}

function transaction(
  overrides: Partial<AppleStoreDecodedTransaction> = {}
): AppleStoreDecodedTransaction {
  return {
    transactionId: `tx-${crypto.randomUUID()}`,
    originalTransactionId: `orig-${crypto.randomUUID()}`,
    bundleId: 'com.kilocode.kiloapp',
    productId: 'kilopass.tier19.monthly.v1',
    purchaseDate: 1_777_626_000_000,
    expiresDate: Date.parse('2030-06-01T00:00:00.000Z'),
    environment: 'Sandbox',
    rawPayload: { test: true },
    ...overrides,
  };
}

async function insertProviderScopedSubscriptionRows(providerSubscriptionId: string) {
  const stripeUser = await insertTestUser();
  const appStoreUser = await insertTestUser();
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;

  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: stripeUser.id,
    payment_provider: KiloPassPaymentProvider.Stripe,
    provider_subscription_id: stripeSubscriptionId,
    stripe_subscription_id: stripeSubscriptionId,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'active',
    cancel_at_period_end: false,
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: null,
  });

  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: appStoreUser.id,
    payment_provider: KiloPassPaymentProvider.AppStore,
    provider_subscription_id: providerSubscriptionId,
    stripe_subscription_id: null,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'active',
    cancel_at_period_end: false,
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: null,
  });

  return { stripeUser, appStoreUser, stripeSubscriptionId };
}

describe('processAppStoreKiloPassNotification', () => {
  let dateNowSpy: jest.SpiedFunction<typeof Date.now>;

  beforeAll(() => {
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(APP_STORE_NOTIFICATION_TEST_NOW_MS);
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });

  it('records a renewal notification and completes the subscription once', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events).toHaveLength(1);
    expect(events[0]?.payment_provider).toBe(KiloPassPaymentProvider.AppStore);
    expect(events[0]?.app_account_token).toBe(user.app_store_account_token);

    const eventPayloadJson = JSON.stringify(events[0]?.payload_json);
    expect(eventPayloadJson).not.toContain(user.app_store_account_token);
    expect(events[0]?.payload_json).toMatchObject({
      notificationType: decodedNotification.notificationType,
      rawTransaction: {
        providerTransactionId: decodedTransaction.transactionId,
        providerSubscriptionId: decodedTransaction.originalTransactionId,
      },
      transaction: {
        providerTransactionId: decodedTransaction.transactionId,
        providerSubscriptionId: decodedTransaction.originalTransactionId,
      },
    });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
  });

  it('deduplicates notification UUIDs', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const params = {
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    };

    await processAppStoreKiloPassNotification(params);
    const replay = await processAppStoreKiloPassNotification(params);

    expect(replay).toEqual({ processed: true, status: 'already_processed' });
  });

  it('does not process concurrent duplicate notification deliveries twice', async () => {
    const decodedNotification = notification({
      notificationUUID: 'concurrent-consumption-request',
      notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
    });
    const decodedTransaction = transaction();
    const sendConsumptionInformation = jest.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
    const params = {
      signedPayload: 'concurrent-consumption-request',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation,
    };

    const results = await Promise.all([
      processAppStoreKiloPassNotification(params),
      processAppStoreKiloPassNotification(params),
    ]);

    expect(results.filter(result => result.processed)).toHaveLength(1);
    expect(results).toContainEqual({ processed: false, status: 'in_flight' });
    expect(sendConsumptionInformation).toHaveBeenCalledTimes(1);
  });

  it('retries a stale unprocessed notification claim', async () => {
    const decodedNotification = notification({
      notificationUUID: 'stale-consumption-request',
      notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
    });
    const decodedTransaction = transaction();
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: decodedNotification.notificationUUID,
      provider_subscription_id: decodedTransaction.originalTransactionId,
      provider_transaction_id: decodedTransaction.transactionId,
      product_id: decodedTransaction.productId,
      environment: 'Sandbox',
      payload_json: {
        notificationType: decodedNotification.notificationType,
      },
      processing_started_at: '2026-01-01T00:00:00.000Z',
      processed_at: null,
    });

    const sendConsumptionInformation = jest.fn(async () => {});
    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'stale-consumption-request',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation,
    });

    expect(result).toEqual({ processed: true });
    expect(sendConsumptionInformation).toHaveBeenCalledTimes(1);

    const event = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID),
    });
    expect(event?.processed_at).not.toBeNull();
    expect(new Date(event?.processing_started_at ?? '').getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime()
    );
  });

  it('records initial buy notifications before the app attaches a user', async () => {
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction();

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events[0]?.processed_at).not.toBeNull();

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(
        eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        )
      );
    expect(subscriptions).toHaveLength(0);
  });

  it('creates the initial subscription from the App Store account token', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.provider_subscription_id).toBe(
      decodedTransaction.originalTransactionId
    );
  });

  it('reprocesses notification rows left unprocessed by an earlier failure', async () => {
    const decodedNotification = notification({
      notificationType: NotificationTypeV2.SUBSCRIBED,
      subtype: Subtype.INITIAL_BUY,
    });
    const decodedTransaction = transaction();
    await db.insert(kilo_pass_store_events).values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: decodedNotification.notificationUUID,
      provider_subscription_id: decodedTransaction.originalTransactionId,
      provider_transaction_id: decodedTransaction.transactionId,
      product_id: decodedTransaction.productId,
      environment: 'Sandbox',
      payload_json: {
        notificationType: decodedNotification.notificationType,
        subtype: decodedNotification.subtype,
      },
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const events = await db
      .select()
      .from(kilo_pass_store_events)
      .where(eq(kilo_pass_store_events.event_id, decodedNotification.notificationUUID));
    expect(events[0]?.processed_at).not.toBeNull();
  });

  it('marks a subscription ended for expiration notifications', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'renewal',
      decodeNotification: async () => notification({ notificationUUID: 'renewal' }),
      decodeTransaction: async () => decodedTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-transaction',
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();
  });

  it('marks a subscription ended when the expiration notification transaction is expired', async () => {
    const user = await insertTestUser();
    const renewalTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-transaction-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-transaction-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => renewalTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-transaction-expired',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-transaction-expired',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: renewalTransaction.originalTransactionId,
          expiresDate: 1_700_000_000_000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        renewalTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();
  });

  it('only ends App Store rows for expiration notifications', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeSubscriptionId } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    await processAppStoreKiloPassNotification({
      signedPayload: 'expired-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'expired-provider-scoped',
          notificationType: NotificationTypeV2.EXPIRED,
          signedTransactionInfo: 'expired-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
        }),
    });

    const [stripeSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId));
    const [appStoreSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));

    expect(stripeSubscription).toMatchObject({
      status: 'active',
      ended_at: null,
    });
    expect(appStoreSubscription).toMatchObject({
      status: 'canceled',
      cancel_at_period_end: false,
    });
    expect(appStoreSubscription?.ended_at).not.toBeNull();
  });

  it('marks auto-renew-disabled notifications as canceling at period end and enabled as resumed', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-disabled',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-disabled',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_DISABLED,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.cancel_at_period_end).toBe(true);
    expect(subscription?.ended_at).toBeNull();

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-enabled',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-enabled',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_ENABLED,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const resumedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(resumedSubscription?.status).toBe('active');
    expect(resumedSubscription?.cancel_at_period_end).toBe(false);
    expect(resumedSubscription?.ended_at).toBeNull();
  });

  it('only marks App Store rows canceling at period end', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeSubscriptionId } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    await processAppStoreKiloPassNotification({
      signedPayload: 'auto-renew-disabled-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'auto-renew-disabled-provider-scoped',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS,
          subtype: Subtype.AUTO_RENEW_DISABLED,
          signedTransactionInfo: 'auto-renew-disabled-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
        }),
    });

    const [stripeSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, stripeSubscriptionId));
    const [appStoreSubscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));

    expect(stripeSubscription?.cancel_at_period_end).toBe(false);
    expect(appStoreSubscription?.cancel_at_period_end).toBe(true);
  });

  it('uses the App Store row when resolving renewal users', async () => {
    const providerSubscriptionId = `shared-${crypto.randomUUID()}`;
    const { stripeUser, appStoreUser } =
      await insertProviderScopedSubscriptionRows(providerSubscriptionId);

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'renewal-provider-scoped',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'renewal-provider-scoped',
          notificationType: NotificationTypeV2.DID_RENEW,
          signedTransactionInfo: 'renewal-provider-scoped-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: appStoreUser.app_store_account_token,
        }),
    });

    expect(result).toEqual({ processed: true });

    const stripeStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, stripeUser.id));
    expect(stripeStorePurchases).toHaveLength(0);

    const appStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, appStoreUser.id));
    expect(appStorePurchases).toHaveLength(1);
  });

  it('rejects renewal notifications whose account token does not match the App Store owner', async () => {
    const owner = await insertTestUser();
    const otherUser = await insertTestUser();
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    await processAppStoreKiloPassNotification({
      signedPayload: 'mismatch-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'mismatch-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: owner.app_store_account_token,
        }),
    });

    const ownerCreditTransactionsBefore = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, owner.id));

    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: 'mismatch-renewal',
        decodeNotification: async () =>
          notification({
            notificationUUID: 'mismatch-renewal',
            notificationType: NotificationTypeV2.DID_RENEW,
            signedTransactionInfo: 'mismatch-renewal-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            transactionId: `tx-${crypto.randomUUID()}`,
            appAccountToken: otherUser.app_store_account_token,
          }),
      })
    ).rejects.toThrow('App Store renewal account token does not match subscription owner');

    const mismatchEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'mismatch-renewal'),
    });
    expect(mismatchEvent?.processed_at).toBeNull();

    const otherUserPurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, otherUser.id));
    expect(otherUserPurchases).toHaveLength(0);

    const ownerCreditTransactionsAfter = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, owner.id));
    expect(ownerCreditTransactionsAfter).toHaveLength(ownerCreditTransactionsBefore.length);
  });

  it('applies App Store upgrade renewal preference notifications immediately', async () => {
    const user = await insertTestUser();
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'upgrade-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          appAccountToken: user.app_store_account_token,
        }),
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'upgrade',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'upgrade',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
          subtype: Subtype.UPGRADE,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: `tx-${crypto.randomUUID()}`,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
        }),
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription?.tier).toBe(KiloPassTier.Tier49);
    expect(subscription?.status).toBe('active');
  });

  it('records failed-renewal notifications without ending the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'failed-renewal-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'failed-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'failed-renewal',
          notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    expect(result).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.cancel_at_period_end).toBe(false);
    expect(subscription?.ended_at).toBeNull();

    const auditRow = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.action} = ${KiloPassAuditLogAction.StoreNotificationReceived} AND ${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'failed-renewal'`,
    });
    expect(auditRow?.payload_json).toMatchObject({
      notificationUUID: 'failed-renewal',
      notificationType: NotificationTypeV2.DID_FAIL_TO_RENEW,
      providerSubscriptionId: decodedTransaction.originalTransactionId,
    });
  });

  it('asks Apple to decline refund requests without ending the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const consumptionRequests: Array<{ transactionId: string; request: unknown }> = [];
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumption-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'consumption-request',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumption-request',
          notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
        }),
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation: async (transactionId, request) => {
        consumptionRequests.push({ transactionId, request });
      },
    });

    expect(result).toEqual({ processed: true });
    expect(consumptionRequests).toEqual([
      {
        transactionId: decodedTransaction.transactionId,
        request: {
          customerConsented: true,
          deliveryStatus: DeliveryStatus.DELIVERED,
          refundPreference: RefundPreference.DECLINE,
          sampleContentProvided: false,
        },
      },
    ]);

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.ended_at).toBeNull();
  });

  it('asks Apple to decline refund requests regardless of credit usage', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({ appAccountToken: user.app_store_account_token });
    const consumptionRequests: Array<{ transactionId: string; request: unknown }> = [];
    await processAppStoreKiloPassNotification({
      signedPayload: 'initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumed-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 1 })
      .where(eq(kilocode_users.id, user.id));

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'consumed-consumption-request',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'consumed-consumption-request',
          notificationType: NotificationTypeV2.CONSUMPTION_REQUEST,
        }),
      decodeTransaction: async () => decodedTransaction,
      sendConsumptionInformation: async (transactionId, request) => {
        consumptionRequests.push({ transactionId, request });
      },
    });

    expect(result).toEqual({ processed: true });
    expect(consumptionRequests).toEqual([
      {
        transactionId: decodedTransaction.transactionId,
        request: {
          customerConsented: true,
          deliveryStatus: DeliveryStatus.DELIVERED,
          refundPreference: RefundPreference.DECLINE,
          sampleContentProvided: false,
        },
      },
    ]);

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription?.status).toBe('active');
    expect(subscription?.ended_at).toBeNull();
  });

  it('does not activate or issue credits when a refund is processed before the purchase notification', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const providerTransactionId = `tx-${crypto.randomUUID()}`;

    const refundResult = await processAppStoreKiloPassNotification({
      signedPayload: 'refund-before-subscribe',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund-before-subscribe',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'refund-before-subscribe-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
        }),
    });
    expect(refundResult).toEqual({ processed: true });

    const subscribeResult = await processAppStoreKiloPassNotification({
      signedPayload: 'subscribe-after-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'subscribe-after-refund',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
          signedTransactionInfo: 'subscribe-after-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
        }),
    });
    expect(subscribeResult).toEqual({ processed: true });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));
    expect(
      subscriptions.filter(row => row.status === 'active' && row.ended_at === null)
    ).toHaveLength(0);

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, providerTransactionId));
    expect(storePurchases).toHaveLength(0);

    const userCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(userCreditTransactions).toHaveLength(0);

    const stalePurchaseAudit = await db.query.kilo_pass_audit_log.findFirst({
      where: sql`${kilo_pass_audit_log.action} = ${KiloPassAuditLogAction.StoreNotificationReceived} AND ${kilo_pass_audit_log.payload_json}->>'notificationUUID' = 'subscribe-after-refund'`,
    });
    expect(stalePurchaseAudit?.payload_json).toMatchObject({
      notificationUUID: 'subscribe-after-refund',
      notificationType: NotificationTypeV2.SUBSCRIBED,
      providerSubscriptionId,
      providerTransactionId,
      skippedStorePurchaseCompletion: true,
    });
  });

  it('does not reactivate a subscription for a delayed renewal predating a terminal event', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const initialTransactionId = `tx-${crypto.randomUUID()}`;
    const delayedRenewalTransactionId = `tx-${crypto.randomUUID()}`;
    const terminalTransactionId = `tx-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification({
      signedPayload: 'delayed-terminal-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'delayed-terminal-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: initialTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
        }),
    });

    const creditTransactionsBeforeTerminal = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    await processAppStoreKiloPassNotification({
      signedPayload: 'terminal-before-delayed-renewal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'terminal-before-delayed-renewal',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'terminal-before-delayed-renewal-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: terminalTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-10T00:00:00.000Z'),
          revocationDate: Date.parse('2026-06-15T00:00:00.000Z'),
        }),
    });

    const delayedRenewalResult = await processAppStoreKiloPassNotification({
      signedPayload: 'delayed-renewal-after-terminal',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'delayed-renewal-after-terminal',
          notificationType: NotificationTypeV2.DID_RENEW,
          signedTransactionInfo: 'delayed-renewal-after-terminal-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: delayedRenewalTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-01T00:00:00.000Z'),
        }),
    });
    expect(delayedRenewalResult).toEqual({ processed: true });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription?.status).toBe('canceled');
    expect(subscription?.ended_at).not.toBeNull();

    const delayedStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, delayedRenewalTransactionId));
    expect(delayedStorePurchases).toHaveLength(0);

    const creditTransactionsAfterDelayedRenewal = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditTransactionsAfterDelayedRenewal).toHaveLength(
      creditTransactionsBeforeTerminal.length
    );
  });

  it('reverses the Apple paid base amount plus issued bonus and promo credits for the refunded issuance', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'USD',
      price: 24700,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });
    expect(issuance).toBeDefined();

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(9.5),
          is_free: true,
          description: 'test Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(4.75),
          is_free: true,
          description: 'test Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          14.25
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 9.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 4.75,
        bonus_percent_applied: 0.25,
      },
    ]);

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'USD',
          price: 24700,
        }),
    });

    expect(result).toEqual({ processed: true });

    const replayedResult = await processAppStoreKiloPassNotification({
      signedPayload: 'revoke',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'revoke',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'revoke-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'USD',
          price: 24700,
        }),
    });
    expect(replayedResult).toEqual({ processed: true });

    const creditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditTransactions.filter(row => row.amountMicrodollars < 0)).toHaveLength(3);
    expect(creditTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(24.7),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
    expect(creditTransactions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
        }),
      ])
    );

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(-toMicrodollars(5.7));
  });

  it('scopes App Store refund reversals to the refunded transaction after a same-month upgrade', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const tx1 = `tx-${crypto.randomUUID()}`;
    const tx2 = `tx-${crypto.randomUUID()}`;

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx1,
          productId: 'kilopass.tier19.monthly.v1',
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-01T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-upgrade',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-upgrade',
          notificationType: NotificationTypeV2.DID_CHANGE_RENEWAL_PREF,
          subtype: Subtype.UPGRADE,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-06-16T00:00:00.000Z'),
          expiresDate: Date.parse('2026-07-16T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
        eq(kilo_pass_issuances.issue_month, '2026-06-01')
      ),
    });
    expect(issuance).toBeDefined();

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(24.5),
          is_free: true,
          description: 'test tx2 Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(12.25),
          is_free: true,
          description: 'test tx2 Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          36.75
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 24.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 12.25,
        bonus_percent_applied: 0.25,
      },
    ]);

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-tx1',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-tx1',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'scoped-refund-tx1-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx1,
          productId: 'kilopass.tier19.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-20T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    let negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'Kilo Pass upgrade refund clawback (tier_19)',
        }),
      ])
    );
    expect(negativeCreditTransactions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(49),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(24.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(12.25),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );

    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-refund-tx2',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-refund-tx2',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'scoped-refund-tx2-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-21T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'scoped-revoke-tx2',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'scoped-revoke-tx2',
          notificationType: NotificationTypeV2.REVOKE,
          signedTransactionInfo: 'scoped-revoke-tx2-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: tx2,
          productId: 'kilopass.tier49.monthly.v1',
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-21T00:00:00.000Z'),
          currency: 'USD',
          price: 49000,
        }),
    });

    negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(49),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(24.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(12.25),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(49) &&
          row.description === 'App Store Kilo Pass refund clawback'
      )
    ).toHaveLength(1);
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(24.5) &&
          row.description === 'App Store Kilo Pass bonus refund clawback'
      )
    ).toHaveLength(1);
    expect(
      negativeCreditTransactions.filter(
        row =>
          row.amountMicrodollars === -toMicrodollars(12.25) &&
          row.description === 'App Store Kilo Pass promo refund clawback'
      )
    ).toHaveLength(1);
  });

  it('processes a EUR refund without throwing and still ends the subscription', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'EUR',
      price: 22900,
    });
    await processAppStoreKiloPassNotification({
      signedPayload: 'eur-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'eur-refund-initial-buy',
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () => decodedTransaction,
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(subscription).toBeDefined();

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });
    expect(issuance).toBeDefined();

    const [promoTransaction] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(4.75),
        is_free: true,
        description: 'test EUR Kilo Pass promo credits',
        credit_category: `test-kilo-pass-promo-eur-${crypto.randomUUID()}`,
      })
      .returning({ id: credit_transactions.id });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(4.75)}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuance?.id ?? '',
      kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      credit_transaction_id: promoTransaction?.id ?? '',
      amount_usd: 4.75,
      bonus_percent_applied: 0.25,
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'eur-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'eur-refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'eur-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          ...decodedTransaction,
          revocationDate: 1_777_700_000_000,
          currency: 'EUR',
          price: 22900,
        }),
    });

    expect(result).toEqual({ processed: true });

    const refundEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'eur-refund'),
    });
    expect(refundEvent?.processed_at).not.toBeNull();

    const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(
        kilo_pass_subscriptions.provider_subscription_id,
        decodedTransaction.originalTransactionId
      ),
    });
    expect(endedSubscription?.status).toBe('canceled');

    const negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amountMicrodollars < 0)).toHaveLength(2);
    const eurBaseAmountMicrodollars = toMicrodollars(19);
    expect(negativeCreditTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -eurBaseAmountMicrodollars,
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
  });

  it('processes a non-USD refund with no recorded purchase amount: still ends subscription and writes processed_at, skips base clawback', async () => {
    const user = await insertTestUser();
    const originalTransactionId = `orig-${crypto.randomUUID()}`;
    const refundTransactionId = `tx-${crypto.randomUUID()}`;

    const [subscriptionRow] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: user.id,
        payment_provider: KiloPassPaymentProvider.AppStore,
        provider_subscription_id: originalTransactionId,
        stripe_subscription_id: null,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: 'active',
        cancel_at_period_end: false,
        started_at: '2026-05-01T00:00:00.000Z',
        ended_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscriptionRow?.id ?? '',
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilopass.tier19.monthly.v1',
      provider_subscription_id: originalTransactionId,
      provider_transaction_id: refundTransactionId,
      environment: 'Sandbox',
      purchased_at: '2026-05-01T00:00:00.000Z',
      raw_payload_json: {},
    });

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'gbp-no-credit-row-refund',
      decodeNotification: async () =>
        notification({
          notificationUUID: 'gbp-no-credit-row-refund',
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'gbp-no-credit-row-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId,
          transactionId: refundTransactionId,
          appAccountToken: user.app_store_account_token,
          revocationDate: 1_777_700_000_000,
          currency: 'GBP',
          price: 19900,
        }),
    });

    expect(result).toEqual({ processed: true });

    const refundEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, 'gbp-no-credit-row-refund'),
    });
    expect(refundEvent?.processed_at).not.toBeNull();

    const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, originalTransactionId),
    });
    expect(endedSubscription?.status).toBe('canceled');

    const negativeCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(negativeCreditTransactions.filter(row => row.amount_microdollars < 0)).toHaveLength(0);
  });

  it.each([
    {
      name: 'missing price',
      refundTransaction: { currency: 'USD', price: undefined },
    },
    {
      name: 'non-finite price',
      refundTransaction: { currency: 'USD', price: Number.POSITIVE_INFINITY },
    },
    {
      name: 'non-positive price',
      refundTransaction: { currency: 'USD', price: 0 },
    },
  ])(
    'ends subscription and writes processed_at even when USD refund price is invalid ($name)',
    async ({ name, refundTransaction }) => {
      const user = await insertTestUser();
      const decodedTransaction = transaction({
        appAccountToken: user.app_store_account_token,
      });
      await processAppStoreKiloPassNotification({
        signedPayload: `invalid-refund-initial-buy-${name}`,
        decodeNotification: async () =>
          notification({
            notificationUUID: `invalid-refund-initial-buy-${name}`,
            notificationType: NotificationTypeV2.SUBSCRIBED,
            subtype: Subtype.INITIAL_BUY,
          }),
        decodeTransaction: async () => decodedTransaction,
      });

      const refundNotificationUUID = `invalid-refund-${name}`;
      const result = await processAppStoreKiloPassNotification({
        signedPayload: refundNotificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID: refundNotificationUUID,
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'invalid-refund-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            ...decodedTransaction,
            revocationDate: 1_777_700_000_000,
            ...refundTransaction,
          }),
      });

      expect(result).toEqual({ processed: true });

      const negativeCreditTransactions = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, user.id));
      expect(negativeCreditTransactions.filter(row => row.amount_microdollars < 0)).toHaveLength(0);

      const refundEvent = await db.query.kilo_pass_store_events.findFirst({
        where: eq(kilo_pass_store_events.event_id, refundNotificationUUID),
      });
      expect(refundEvent?.processed_at).not.toBeNull();

      const endedSubscription = await db.query.kilo_pass_subscriptions.findFirst({
        where: eq(
          kilo_pass_subscriptions.provider_subscription_id,
          decodedTransaction.originalTransactionId
        ),
      });
      expect(endedSubscription?.status).toBe('canceled');
    }
  );

  it('rolls back credit reversal and processed_at write when markStoreSubscriptionEnded throws', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const notificationUUID = `rollback-refund-${crypto.randomUUID()}`;

    // Seed a subscription + store purchase + promo issuance item
    await processAppStoreKiloPassNotification({
      signedPayload: 'rollback-refund-initial-buy',
      decodeNotification: async () =>
        notification({
          notificationUUID: `rollback-refund-initial-buy-${notificationUUID}`,
          notificationType: NotificationTypeV2.SUBSCRIBED,
          subtype: Subtype.INITIAL_BUY,
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          purchaseDate: Date.parse('2026-05-01T00:00:00.000Z'),
          expiresDate: Date.parse('2026-06-01T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
    });

    const [promoTransaction] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(4.75),
        is_free: true,
        description: 'test promo credits for rollback test',
        credit_category: `test-kilo-pass-promo-rollback-${crypto.randomUUID()}`,
      })
      .returning({ id: credit_transactions.id });

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuance?.id ?? '',
      kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      credit_transaction_id: promoTransaction?.id ?? '',
      amount_usd: 4.75,
      bonus_percent_applied: 0.25,
    });

    const failingEndSubscription = jest.fn(async () => {
      throw new Error('simulated DB failure in markStoreSubscriptionEnded');
    });

    // First attempt — should reject because endStoreSubscription throws inside the outer tx
    await expect(
      processAppStoreKiloPassNotification({
        signedPayload: notificationUUID,
        decodeNotification: async () =>
          notification({
            notificationUUID,
            notificationType: NotificationTypeV2.REFUND,
            signedTransactionInfo: 'rollback-refund-transaction',
          }),
        decodeTransaction: async () =>
          transaction({
            originalTransactionId: providerSubscriptionId,
            transactionId: providerTransactionId,
            appAccountToken: user.app_store_account_token,
            revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
            currency: 'USD',
            price: 19000,
          }),
        endStoreSubscription: failingEndSubscription,
      })
    ).rejects.toThrow('simulated DB failure in markStoreSubscriptionEnded');

    // processed_at must be null — the outer tx was rolled back
    const failedEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, notificationUUID),
    });
    expect(failedEvent?.processed_at).toBeNull();

    // No negative credit_transactions exist (rollback succeeded)
    const creditsBefore = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditsBefore.filter(row => row.amount_microdollars < 0)).toHaveLength(0);

    // Reset processing_started_at to a stale timestamp to allow retry (simulates processing after the
    // store event claim TTL has elapsed following the first failed attempt)
    await db
      .update(kilo_pass_store_events)
      .set({ processing_started_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(kilo_pass_store_events.event_id, notificationUUID));

    // Second attempt without the override — full success, no duplicates
    const result = await processAppStoreKiloPassNotification({
      signedPayload: notificationUUID,
      decodeNotification: async () =>
        notification({
          notificationUUID,
          notificationType: NotificationTypeV2.REFUND,
          signedTransactionInfo: 'rollback-refund-transaction',
        }),
      decodeTransaction: async () =>
        transaction({
          originalTransactionId: providerSubscriptionId,
          transactionId: providerTransactionId,
          appAccountToken: user.app_store_account_token,
          revocationDate: Date.parse('2026-05-02T00:00:00.000Z'),
          currency: 'USD',
          price: 19000,
        }),
    });
    expect(result).toEqual({ processed: true });

    const successEvent = await db.query.kilo_pass_store_events.findFirst({
      where: eq(kilo_pass_store_events.event_id, notificationUUID),
    });
    expect(successEvent?.processed_at).not.toBeNull();

    // Exactly one set of clawback rows — base + promo, not doubled
    const negativeCreditTransactions = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    const negatives = negativeCreditTransactions.filter(row => row.amountMicrodollars < 0);
    expect(negatives).toHaveLength(2);
    expect(negatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(19),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(4.75),
          description: 'App Store Kilo Pass promo refund clawback',
        }),
      ])
    );
  });
});
