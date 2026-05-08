import { describe, expect, it } from '@jest/globals';
import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  Subtype,
} from '@apple/app-store-server-library';
import { eq } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilocode_users,
  kilo_pass_audit_log,
  kilo_pass_store_events,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  KiloPassAuditLogAction,
  KiloPassIssuanceItemKind,
  KiloPassPaymentProvider,
  KiloPassTier,
} from './enums';
import { processAppStoreKiloPassNotification } from './apple-store-notifications';
import type { AppleStoreDecodedNotification } from './apple-store-notifications';
import type { AppleStoreDecodedTransaction } from './apple-store-verifier';
import { toMicrodollars } from '@/lib/utils';

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
    expiresDate: 1_780_218_000_000,
    environment: 'Sandbox',
    rawPayload: { test: true },
    ...overrides,
  };
}

describe('processAppStoreKiloPassNotification', () => {
  it('records a renewal notification and completes the subscription once', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction();

    const result = await processAppStoreKiloPassNotification({
      signedPayload: 'payload',
      userForRenewal: user,
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

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
  });

  it('deduplicates notification UUIDs', async () => {
    const user = await insertTestUser();
    const decodedNotification = notification();
    const decodedTransaction = transaction();
    const params = {
      signedPayload: 'payload',
      userForRenewal: user,
      decodeNotification: async () => decodedNotification,
      decodeTransaction: async () => decodedTransaction,
    };

    await processAppStoreKiloPassNotification(params);
    const replay = await processAppStoreKiloPassNotification(params);

    expect(replay).toEqual({ processed: false });
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
    const decodedTransaction = transaction();
    await processAppStoreKiloPassNotification({
      signedPayload: 'renewal',
      userForRenewal: user,
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

  it('marks auto-renew-disabled notifications as canceling at period end', async () => {
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
      where: eq(kilo_pass_audit_log.action, KiloPassAuditLogAction.StoreNotificationReceived),
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

  it('asks Apple to decline refund requests when Kilo Pass credits were consumed', async () => {
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

  it('subtracts the Apple refunded amount and all bonus credits for the refunded issuance', async () => {
    const user = await insertTestUser();
    const decodedTransaction = transaction({
      appAccountToken: user.app_store_account_token,
      currency: 'USD',
      price: 5000,
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

    const bonusTransaction = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        amount_microdollars: toMicrodollars(9.5),
        is_free: true,
        description: 'test Kilo Pass bonus credits',
        credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
      })
      .returning({ id: credit_transactions.id });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${toMicrodollars(
          9.5
        )}`,
      })
      .where(eq(kilocode_users.id, user.id));

    await db.insert(kilo_pass_issuance_items).values({
      kilo_pass_issuance_id: issuance?.id ?? '',
      kind: KiloPassIssuanceItemKind.Bonus,
      credit_transaction_id: bonusTransaction[0]?.id ?? '',
      amount_usd: 9.5,
      bonus_percent_applied: 0.5,
    });

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
          price: 5000,
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
          price: 5000,
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
    expect(creditTransactions.filter(row => row.amountMicrodollars < 0)).toHaveLength(2);
    expect(creditTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(5),
          description: 'App Store Kilo Pass refund clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -toMicrodollars(9.5),
          description: 'App Store Kilo Pass bonus refund clawback',
        }),
      ])
    );

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(toMicrodollars(14));
  });
});
