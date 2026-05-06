import { apple_iap_notifications } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { verifyAppleNotificationJws, verifyAppleTransactionJws } from './verifier';
import { reverseAppleCreditPurchase } from './purchases';
import type { AppleDecodedNotification, AppleDecodedTransaction } from './types';

const REVERSAL_NOTIFICATION_TYPES = new Set(['REFUND', 'REVOKE', 'CONSUMPTION_REQUEST']);

export async function processAppleIapNotification(params: {
  signedPayload: string;
  verifyNotification?: (signedPayload: string) => Promise<AppleDecodedNotification>;
  verifyTransaction?: (transactionJws: string) => Promise<AppleDecodedTransaction>;
}): Promise<{ duplicate: boolean; reversed: boolean }> {
  const verifyNotification = params.verifyNotification ?? verifyAppleNotificationJws;
  const verifyTransaction = params.verifyTransaction ?? verifyAppleTransactionJws;
  const notification = await verifyNotification(params.signedPayload);
  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  const transaction = signedTransactionInfo ? await verifyTransaction(signedTransactionInfo) : null;

  const insert = await db
    .insert(apple_iap_notifications)
    .values({
      notification_uuid: notification.notificationUUID,
      notification_type: notification.notificationType,
      subtype: notification.subtype ?? null,
      environment: notification.data?.environment ?? transaction?.environment ?? 'Sandbox',
      apple_transaction_id: transaction?.transactionId ?? null,
      apple_original_transaction_id: transaction?.originalTransactionId ?? null,
      signed_payload_jws: params.signedPayload,
    })
    .onConflictDoNothing();

  if ((insert.rowCount ?? 0) === 0) {
    return { duplicate: true, reversed: false };
  }

  let reversed = false;
  if (transaction && REVERSAL_NOTIFICATION_TYPES.has(notification.notificationType)) {
    const result = await reverseAppleCreditPurchase({
      appleTransactionId: transaction.transactionId,
      reversalReason: notification.notificationType === 'REFUND' ? 'refunded' : 'revoked',
    });
    reversed = result.reversed;
  }

  await db
    .update(apple_iap_notifications)
    .set({ processed_at: new Date().toISOString() })
    .where(eq(apple_iap_notifications.notification_uuid, notification.notificationUUID));

  return { duplicate: false, reversed };
}
