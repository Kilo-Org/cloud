import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { kilo_pass_store_events, kilo_pass_subscriptions } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { KiloPassPaymentProvider } from './enums';
import { processAppStoreKiloPassNotification } from './apple-store-notifications';
import type { AppleStoreDecodedNotification } from './apple-store-notifications';
import type { AppleStoreDecodedTransaction } from './apple-store-verifier';

function notification(
  overrides: Partial<AppleStoreDecodedNotification> = {}
): AppleStoreDecodedNotification {
  return {
    notificationUUID: `note-${crypto.randomUUID()}`,
    notificationType: 'DID_RENEW',
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
          notificationType: 'EXPIRED',
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
});
