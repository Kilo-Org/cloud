import { db } from '@/lib/drizzle';
import { processAppleCreditPurchase } from './purchases';
import { processAppleIapNotification } from './notifications';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { apple_iap_notifications, credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

const transaction = {
  transactionId: 'apple-notification-txn-1',
  originalTransactionId: 'apple-notification-original-1',
  bundleId: 'com.kilocode.kiloapp',
  productId: 'com.kilocode.kiloapp.credits.small.999',
  purchaseDate: Date.UTC(2026, 0, 1),
  environment: 'Sandbox' as const,
};

describe('processAppleIapNotification', () => {
  it('records duplicate notification UUIDs idempotently', async () => {
    const notification = {
      notificationUUID: 'notification-duplicate-1',
      notificationType: 'DID_RENEW',
      data: { environment: 'Sandbox' as const },
    };

    const first = await processAppleIapNotification({
      signedPayload: 'signed-notification',
      verifyNotification: async () => notification,
    });
    const second = await processAppleIapNotification({
      signedPayload: 'signed-notification',
      verifyNotification: async () => notification,
    });

    expect(first).toEqual({ duplicate: false, reversed: false });
    expect(second).toEqual({ duplicate: true, reversed: false });
  });

  it('reverses a refund notification once', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });
    await processAppleCreditPurchase({
      user,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => transaction,
    });

    const result = await processAppleIapNotification({
      signedPayload: 'signed-refund-notification',
      verifyNotification: async () => ({
        notificationUUID: 'notification-refund-1',
        notificationType: 'REFUND',
        data: {
          environment: 'Sandbox',
          signedTransactionInfo: 'signed-transaction',
        },
      }),
      verifyTransaction: async () => transaction,
    });

    expect(result).toEqual({ duplicate: false, reversed: true });

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(0);

    const transactions = await db.query.credit_transactions.findMany({
      where: eq(credit_transactions.kilo_user_id, user.id),
    });
    expect(transactions.map(t => t.amount_microdollars).sort((a, b) => a - b)).toEqual([
      -6_990_000, 6_990_000,
    ]);

    const storedNotification = await db.query.apple_iap_notifications.findFirst({
      where: eq(apple_iap_notifications.notification_uuid, 'notification-refund-1'),
    });
    expect(storedNotification?.processed_at).toBeTruthy();
  });
});
