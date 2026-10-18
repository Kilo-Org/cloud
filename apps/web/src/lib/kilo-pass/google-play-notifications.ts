import { and, eq, sql } from 'drizzle-orm';

import { credit_transactions, kilo_pass_store_events } from '@kilocode/db/schema';
import type { BouncerCreditEventOutboxDatabase } from '@kilocode/db/bouncer-credit-event-outbox';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@kilocode/web-shared/lib/kilo-pass/issuance';
import {
  GOOGLE_PLAY_PACKAGE_NAME,
  getGooglePlayProductPurchase,
  getGooglePlayOrder,
} from './google-play-sdk';
import type { StoreCreditEvent, StoreEventKind } from '@kilocode/web-shared/lib/bouncer/client';
import { enqueueCreditEvent } from '@kilocode/web-shared/lib/bouncer/credit-events';
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import { getStoreCreditProductByGoogleProductId } from '@/lib/credits/store-products';
import { googlePlayCreditProviderTransactionId } from '@/lib/credits/store-verifier';
import {
  lockStoreCreditPurchase,
  reverseStoreCreditPurchase,
  STORE_FULL_MILLIUNITS,
} from '@/lib/credits/store-refund';

type DbOrTx = DrizzleTransaction | typeof db;

export type GooglePlayPubSubMessage = {
  data: string;
  messageId?: string;
};

type GooglePlayDeveloperNotification = {
  packageName?: string;
  eventTimeMillis?: string | number;
  voidedPurchaseNotification?: {
    purchaseToken?: string;
    orderId?: string;
    productType?: number;
    refundType?: number;
  };
  subscriptionNotification?: {
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
};

export type GooglePlayKiloPassNotificationProcessingResult =
  | { processed: true }
  | { processed: true; status: 'already_processed' }
  | { processed: false; status: 'in_flight' };

// Google Play VoidedPurchaseNotification.productType and refundType:
// https://developer.android.com/google/play/billing/rtdn-reference#voided
const GOOGLE_PLAY_VOIDED_PRODUCT_TYPE = {
  SUBSCRIPTION: 1,
  ONE_TIME_PRODUCT: 2,
} as const;
const GOOGLE_PLAY_VOIDED_REFUND_TYPE = {
  FULL_REFUND: 1,
  QUANTITY_BASED_PARTIAL_REFUND: 2,
} as const;

const STORE_EVENT_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

type StoreEventClaimStatus = 'claimed' | 'already_processed' | 'in_flight';

function decodeGooglePlayDeveloperNotification(data: string): GooglePlayDeveloperNotification {
  const json = Buffer.from(data, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Google Play notification payload is not a JSON object');
  }
  return parsed as GooglePlayDeveloperNotification;
}

function computeGooglePlayEventId(params: {
  messageId?: string;
  purchaseToken: string;
  notificationType: number | 'voided_purchase';
  eventTimeMillis: string | number | null;
}): string {
  if (params.messageId) {
    return params.messageId;
  }
  if (params.eventTimeMillis != null) {
    return `${params.purchaseToken}:${params.notificationType}:${params.eventTimeMillis}`;
  }
  throw new Error('Google Play notification missing event id');
}

function getGooglePlayStoreEventPayload(params: {
  notificationType: number | 'voided_purchase';
  packageName: string;
  eventTimeMillis: string | number | null;
  purchaseToken: string;
  latestOrderId: string;
  appAccountToken: string | null;
  productId: string;
  environment: string;
}): Record<string, unknown> {
  return redactStoreAccountLinkedJson({
    notificationType: params.notificationType,
    packageName: params.packageName,
    eventTimeMillis: params.eventTimeMillis,
    purchaseToken: params.purchaseToken,
    latestOrderId: params.latestOrderId,
    appAccountToken: params.appAccountToken,
    productId: params.productId,
    environment: params.environment,
  });
}

async function claimGooglePlayStoreEventForProcessing(params: {
  eventId: string;
  notificationType: number | 'voided_purchase';
  packageName: string;
  eventTimeMillis: string | number | null;
  purchaseToken: string;
  latestOrderId: string;
  appAccountToken: string | null;
  productId: string;
  environment: string;
}): Promise<StoreEventClaimStatus> {
  const processingStartedAtIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STORE_EVENT_CLAIM_STALE_AFTER_MS).toISOString();

  const payloadJson = getGooglePlayStoreEventPayload(params);

  const claimedRows = await db
    .insert(kilo_pass_store_events)
    .values({
      payment_provider: KiloPassPaymentProvider.GooglePlay,
      event_id: params.eventId,
      provider_subscription_id: params.purchaseToken,
      provider_transaction_id: params.latestOrderId,
      app_account_token: params.appAccountToken,
      product_id: params.productId,
      environment: params.environment,
      payload_json: payloadJson,
      processing_started_at: processingStartedAtIso,
    })
    .onConflictDoUpdate({
      target: [kilo_pass_store_events.payment_provider, kilo_pass_store_events.event_id],
      set: {
        provider_subscription_id: params.purchaseToken,
        provider_transaction_id: params.latestOrderId,
        app_account_token: params.appAccountToken,
        product_id: params.productId,
        environment: params.environment,
        payload_json: payloadJson,
        processing_started_at: processingStartedAtIso,
      },
      setWhere: sql`${kilo_pass_store_events.processed_at} IS NULL AND (${kilo_pass_store_events.processing_started_at} IS NULL OR ${kilo_pass_store_events.processing_started_at} < ${staleBeforeIso})`,
    })
    .returning({ id: kilo_pass_store_events.id });

  if (claimedRows.length > 0) {
    return 'claimed';
  }

  const existingEvent = await db.query.kilo_pass_store_events.findFirst({
    columns: { processed_at: true },
    where: and(
      eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
      eq(kilo_pass_store_events.event_id, params.eventId)
    ),
  });

  return existingEvent?.processed_at ? 'already_processed' : 'in_flight';
}

async function markGooglePlayStoreEventProcessed(
  eventId: string,
  dbOrTx: DbOrTx = db
): Promise<void> {
  await dbOrTx
    .update(kilo_pass_store_events)
    .set({ processed_at: new Date().toISOString() })
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.event_id, eventId)
      )
    );
}

/** Play `eventTimeMillis` is milliseconds since the epoch, as a string or a number. */
function googlePlayEventTime(eventTimeMillis: string | number | null): Date | undefined {
  if (eventTimeMillis === null) return undefined;
  const millis = Number(eventTimeMillis);
  return Number.isFinite(millis) ? new Date(millis) : undefined;
}

/**
 * Enqueues one Play money event into bouncer's durable outbox, in the caller's transaction.
 * Production events for a resolved Kilo account only: a store event carries no card and no client
 * IP. The insert is atomic with the caller's primary write, so a crash or DB error retries the
 * event instead of losing the report.
 */
async function enqueueGooglePlayCreditEventToBouncer(
  database: BouncerCreditEventOutboxDatabase,
  params: {
    environment: string;
    eventId: string;
    eventTimeMillis: string | number | null;
    referenceId: string;
    /** Null when the notification maps to no store money event. */
    event: StoreEventKind | null;
    userId: string | null;
  }
): Promise<void> {
  if (params.environment !== 'Production' || params.userId === null || params.event === null) {
    return;
  }
  const event: StoreCreditEvent = {
    ...params.event,
    provider: 'google',
    eventId: params.eventId,
    occurredAt: googlePlayEventTime(params.eventTimeMillis),
    userId: params.userId,
    referenceId: params.referenceId,
    environment: 'production',
  };
  await enqueueCreditEvent(database, event);
}

export async function processGooglePlayKiloPassNotification(params: {
  pubsubMessage: GooglePlayPubSubMessage;
}): Promise<GooglePlayKiloPassNotificationProcessingResult> {
  const { data, messageId } = params.pubsubMessage;
  const developerNotification = decodeGooglePlayDeveloperNotification(data);

  if (developerNotification.packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
    throw new Error('Google Play notification package mismatch');
  }

  const voided = developerNotification.voidedPurchaseNotification;
  const subscription = developerNotification.subscriptionNotification;
  if (subscription || voided?.productType === GOOGLE_PLAY_VOIDED_PRODUCT_TYPE.SUBSCRIPTION) {
    // Store subscriptions have been retired. Record delivery deduplication only;
    // never fetch purchases/orders or change historical subscriptions or credits.
    const purchaseToken = subscription?.purchaseToken ?? voided?.purchaseToken;
    const notificationType = subscription?.notificationType ?? 'voided_purchase';
    if (!purchaseToken || (subscription && subscription.notificationType == null)) {
      throw new Error('Google Play notification missing subscription identifiers');
    }
    const eventId = computeGooglePlayEventId({
      messageId,
      purchaseToken,
      notificationType,
      eventTimeMillis: developerNotification.eventTimeMillis ?? null,
    });
    const claim = await claimGooglePlayStoreEventForProcessing({
      eventId,
      notificationType,
      packageName: developerNotification.packageName,
      eventTimeMillis: developerNotification.eventTimeMillis ?? null,
      purchaseToken,
      latestOrderId: voided?.orderId ?? '',
      appAccountToken: null,
      productId: subscription?.subscriptionId ?? 'unknown',
      environment: 'unknown',
    });
    if (claim === 'already_processed') return { processed: true, status: 'already_processed' };
    if (claim === 'in_flight') return { processed: false, status: 'in_flight' };
    await markGooglePlayStoreEventProcessed(eventId);
    return { processed: true };
  }

  if (
    voided?.productType === GOOGLE_PLAY_VOIDED_PRODUCT_TYPE.ONE_TIME_PRODUCT &&
    (voided.refundType === GOOGLE_PLAY_VOIDED_REFUND_TYPE.FULL_REFUND ||
      voided.refundType === GOOGLE_PLAY_VOIDED_REFUND_TYPE.QUANTITY_BASED_PARTIAL_REFUND)
  ) {
    const { purchaseToken, orderId } = voided;
    if (!purchaseToken || !orderId) throw new Error('Google Play refund missing identifiers');
    const order = await getGooglePlayOrder(orderId);
    const lineItem = order.lineItems?.[0];
    if (!getStoreCreditProductByGoogleProductId(lineItem?.productId ?? '')) {
      // A voided one-time product Kilo does not sell as a credit pack has
      // nothing to reverse.
      return { processed: true };
    }
    // A one-time product cannot be refunded pro rata: Play refunds the whole
    // order or, for a multi-quantity purchase, whole units. Kilo sells credit
    // packs one unit at a time, so a quantity-based refund of a single unit is
    // the whole pack. A multi-quantity refund would need the refunded quantity,
    // which the notification does not carry, so it is rejected rather than
    // guessed.
    if (
      voided.refundType === GOOGLE_PLAY_VOIDED_REFUND_TYPE.QUANTITY_BASED_PARTIAL_REFUND &&
      (lineItem?.oneTimePurchaseDetails?.quantity ?? 1) !== 1
    ) {
      throw new Error('Google Play multi-quantity credit pack refund is not supported');
    }
    // Play reports a whole-order refund as REFUNDED and a quantity-based refund as
    // PARTIALLY_REFUNDED. A credit pack is sold one unit at a time, so a
    // quantity-based refund of that single unit refunds the whole pack.
    const refundedOrderStates =
      voided.refundType === GOOGLE_PLAY_VOIDED_REFUND_TYPE.QUANTITY_BASED_PARTIAL_REFUND
        ? ['REFUNDED', 'PARTIALLY_REFUNDED']
        : ['REFUNDED'];
    if (
      order.orderId !== orderId ||
      order.purchaseToken !== purchaseToken ||
      !refundedOrderStates.includes(order.state ?? '')
    ) {
      throw new Error('Google Play refund does not match a refunded order');
    }
    const productId = lineItem?.productId ?? '';
    const eventId = computeGooglePlayEventId({
      messageId,
      purchaseToken,
      notificationType: 'voided_purchase',
      eventTimeMillis: developerNotification.eventTimeMillis ?? null,
    });
    const claim = await claimGooglePlayStoreEventForProcessing({
      eventId,
      notificationType: 'voided_purchase',
      packageName: developerNotification.packageName,
      eventTimeMillis: developerNotification.eventTimeMillis ?? null,
      purchaseToken,
      latestOrderId: orderId,
      appAccountToken: null,
      productId,
      environment: 'Production',
    });
    if (claim === 'already_processed') return { processed: true, status: 'already_processed' };
    if (claim === 'in_flight') return { processed: false, status: 'in_flight' };
    // The order carries no test flag, so a license-tester refund is told apart by the
    // purchase's `purchaseType` (0 = test), as the grant path does. The event is already
    // processed, so a failed lookup must not drop a real refund: an unknown type reports
    // as production. The lookup is an external call, so it stays outside the transaction.
    const purchaseType = await getGooglePlayProductPurchase(productId, purchaseToken).then(
      purchase => purchase.purchaseType,
      () => undefined
    );
    let refundedUserId: string | null = null;
    await db.transaction(async tx => {
      // Serialize with a completion of the same purchase, in either order. The
      // completion keys the grant by the order id, or by a digest of the
      // purchase token when Play reported none, so both ids are locked here;
      // the reversal itself still tries the order id first and falls back to
      // the digest. The raw token is never a lock key or a ledger key.
      const tokenKey = googlePlayCreditProviderTransactionId({ purchaseToken });
      await lockStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerTransactionIds: [orderId, tokenKey],
      });

      // The grant is keyed by the order id when Play reported one and by the
      // token digest otherwise, while a voided notification always carries an
      // order id. Try the order id first and fall back to the digest so a
      // grant keyed by the token is still clawed back exactly.
      let reversal = await reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerTransactionId: orderId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      });
      if (reversal.creditTransactionId === null) {
        reversal = await reverseStoreCreditPurchase(tx, {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionId: tokenKey,
          refundedMilliunits: STORE_FULL_MILLIUNITS,
        });
      }
      if (reversal.creditTransactionId) {
        const [clawback] = await tx
          .select({ kiloUserId: credit_transactions.kilo_user_id })
          .from(credit_transactions)
          .where(eq(credit_transactions.id, reversal.creditTransactionId))
          .limit(1);
        refundedUserId = clawback?.kiloUserId ?? null;
      }
      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
        result: KiloPassAuditLogResult.Success,
        payload: {
          messageId: messageId ?? null,
          providerTransactionId: orderId,
          storeCreditReversal: reversal,
        },
      });
      // Only a pack Kilo granted and clawed back is a customer refund to report; the
      // enqueue returns early when no user was clawed back.
      await enqueueGooglePlayCreditEventToBouncer(tx, {
        environment: purchaseType === 0 ? 'Sandbox' : 'Production',
        eventId,
        eventTimeMillis: developerNotification.eventTimeMillis ?? null,
        referenceId: orderId,
        event: { type: 'store.refund', reason: 'other' },
        userId: refundedUserId,
      });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: new Date().toISOString() })
        .where(
          and(
            eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
            eq(kilo_pass_store_events.event_id, eventId)
          )
        );
    });
    return { processed: true };
  }

  // Other product and test notifications retain their existing ACK-only behavior.
  return { processed: true };
}
