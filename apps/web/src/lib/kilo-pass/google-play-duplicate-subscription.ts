import { and, eq } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

import { kilo_pass_store_events } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { KiloPassAuditLogAction, KiloPassAuditLogResult, KiloPassPaymentProvider } from './enums';
import { appendKiloPassAuditLog } from './issuance';
import { revokeGooglePlaySubscriptionPurchase } from './google-play-sdk';

export type ReverseDuplicateGooglePlaySubscriptionParams = {
  kiloUserId: string;
  productId: string;
  purchaseToken: string;
  providerSubscriptionId: string;
  providerTransactionId: string;
  amountChargedMinorUnits: number | null;
  currency: string | null;
  taxMinorUnits: number | null;
  messageId: string | null;
  eventId: string;
};

/**
 * Reverses a paid Google Play subscription that cannot be admitted because the
 * user already holds a Kilo Pass: refunds the latest order, revokes the
 * duplicate subscription, records the reversal, and only then retires the
 * notification that carried it.
 *
 * The revoke runs before the database transaction because it is a Play network
 * call. A failed revoke throws and leaves the notification unprocessed: a
 * charged order must never be retired without a reversal.
 */
export async function reverseDuplicateGooglePlaySubscription(
  params: ReverseDuplicateGooglePlaySubscriptionParams
): Promise<void> {
  try {
    await revokeGooglePlaySubscriptionPurchase(params.purchaseToken);
  } catch (error) {
    captureException(error, {
      tags: { area: 'kilo-pass', operation: 'reverse-duplicate-google-play-subscription' },
    });
    throw error;
  }

  await db.transaction(async tx => {
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: params.kiloUserId,
      payload: {
        messageId: params.messageId,
        providerSubscriptionId: params.providerSubscriptionId,
        providerTransactionId: params.providerTransactionId,
        duplicateActiveSubscription: true,
        amountChargedMinorUnits: params.amountChargedMinorUnits,
        currency: params.currency,
        taxMinorUnits: params.taxMinorUnits,
      },
    });
    await tx
      .update(kilo_pass_store_events)
      .set({ processed_at: new Date().toISOString() })
      .where(
        and(
          eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
          eq(kilo_pass_store_events.event_id, params.eventId)
        )
      );
  });
}
