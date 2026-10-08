import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  RevocationType,
  RevocationReason,
  type ConsumptionRequest,
} from '@apple/app-store-server-library';
import { and, eq, sql } from 'drizzle-orm';
import * as z from 'zod';

import { credit_transactions, kilo_pass_store_events, kilocode_users } from '@kilocode/db/schema';
import type { BouncerCreditEventOutboxDatabase } from '@kilocode/db/bouncer-credit-event-outbox';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@kilocode/web-shared/lib/kilo-pass/issuance';
import {
  createAppleStoreServerApiClient,
  createAppleStoreSignedDataVerifier,
  decodeAppleStoreTransactionJws,
  normalizeEnvironment,
  type AppleStoreDecodedTransaction,
  type AppleStoreEnvironment,
} from './apple-store-sdk';
import type { StoreCreditEvent, StoreEventKind } from '@kilocode/web-shared/lib/bouncer/client';
import { enqueueCreditEvent } from '@kilocode/web-shared/lib/bouncer/credit-events';
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import {
  getStoreCreditProductByAppleProductId,
  storeCreditPaymentId,
} from '@/lib/credits/store-products';
import {
  getStoreCreditConsumptionMilliunits,
  isStoreRefundDeliverySuperseded,
  lockStoreCreditPurchase,
  restoreStoreCreditPurchase,
  reverseStoreCreditPurchase,
  STORE_FULL_MILLIUNITS,
  type StoreCreditRestorationResult,
  type StoreCreditReversalResult,
} from '@/lib/credits/store-refund';

export type AppleStoreDecodedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  environment: AppleStoreEnvironment;
  /**
   * The UNIX time, in milliseconds, that the App Store signed the notification.
   * It is the store's own chronology, so deliveries that arrive out of order
   * are still ordered by it.
   */
  signedDate?: number;
  signedTransactionInfo?: string;
};

type DecodeNotification = (signedPayload: string) => Promise<AppleStoreDecodedNotification>;
type DecodeTransaction = (signedTransactionJws: string) => Promise<AppleStoreDecodedTransaction>;
type SendConsumptionInformation = (
  transactionId: string,
  request: ConsumptionRequest
) => Promise<void>;
type StoreEventClaimStatus = 'claimed' | 'already_processed' | 'in_flight';
export type AppStoreKiloPassNotificationProcessingResult =
  | { processed: true }
  | { processed: true; status: 'already_processed' }
  | { processed: false; status: 'in_flight' };

const REFUND_TYPES = new Set<string>([NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE]);
const STORE_EVENT_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

const AppleStoreNotificationPayloadSchema = z
  .object({
    notificationUUID: z.string().min(1),
    notificationType: z.string().min(1),
    subtype: z.string().optional(),
    signedDate: z.number().optional(),
    data: z
      .object({
        environment: z.string().optional(),
        signedTransactionInfo: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

async function sendAppleStoreConsumptionInformation(
  transactionId: string,
  request: ConsumptionRequest
): Promise<void> {
  await createAppleStoreServerApiClient().sendConsumptionInformation(transactionId, request);
}

/**
 * A credit pack asks Apple to refund only its unspent share: `consumptionPercentage` is
 * the pack's consumed share (see `getStoreCreditConsumptionMilliunits`). A pack Kilo
 * never granted has no share to prorate, so its refund request is declined.
 */
async function getAppStoreRefundConsumptionRequest(
  transaction: AppleStoreDecodedTransaction
): Promise<ConsumptionRequest> {
  const consumptionPercentage = getStoreCreditProductByAppleProductId(transaction.productId)
    ? await getStoreCreditConsumptionMilliunits(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId: transaction.transactionId,
      })
    : null;
  if (consumptionPercentage === null) {
    return {
      customerConsented: true,
      deliveryStatus: DeliveryStatus.DELIVERED,
      refundPreference: RefundPreference.DECLINE,
      sampleContentProvided: false,
    };
  }
  return {
    customerConsented: true,
    deliveryStatus: DeliveryStatus.DELIVERED,
    consumptionPercentage,
    refundPreference: RefundPreference.GRANT_PRORATED,
    sampleContentProvided: false,
  };
}

export async function decodeAppleStoreNotificationJws(
  signedPayload: string
): Promise<AppleStoreDecodedNotification> {
  const decoded =
    await createAppleStoreSignedDataVerifier().verifyAndDecodeNotification(signedPayload);

  const parsed = AppleStoreNotificationPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error('Apple notification payload missing required identifiers');
  }
  const payload = parsed.data;

  return {
    notificationUUID: payload.notificationUUID,
    notificationType: payload.notificationType,
    subtype: payload.subtype,
    environment: normalizeEnvironment(payload.data?.environment),
    signedDate: payload.signedDate,
    signedTransactionInfo: payload.data?.signedTransactionInfo,
  };
}

function getStoreEventPayload(params: {
  notification: AppleStoreDecodedNotification;
  transaction: AppleStoreDecodedTransaction | null;
}): Record<string, unknown> {
  return redactStoreAccountLinkedJson({
    notificationType: params.notification.notificationType,
    subtype: params.notification.subtype ?? null,
    signedDate: params.notification.signedDate ?? null,
    transaction: null,
    rawTransaction: params.transaction
      ? {
          productId: params.transaction.productId,
          providerSubscriptionId: params.transaction.originalTransactionId,
          providerTransactionId: params.transaction.transactionId,
          appAccountToken: params.transaction.appAccountToken ?? null,
          purchaseDate: params.transaction.purchaseDate,
          revocationDate: params.transaction.revocationDate ?? null,
          expiresDate: params.transaction.expiresDate ?? null,
          environment: params.transaction.environment,
          currency: params.transaction.currency ?? null,
          price: params.transaction.price ?? null,
        }
      : null,
  });
}

async function claimStoreEventForProcessing(params: {
  notification: AppleStoreDecodedNotification;
  transaction: AppleStoreDecodedTransaction | null;
}): Promise<StoreEventClaimStatus> {
  const processingStartedAtIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STORE_EVENT_CLAIM_STALE_AFTER_MS).toISOString();

  const providerSubscriptionId = params.transaction?.originalTransactionId ?? null;
  const providerTransactionId = params.transaction?.transactionId ?? null;
  const appAccountToken = params.transaction?.appAccountToken ?? null;
  const productId = params.transaction?.productId ?? 'unknown';
  const payloadJson = getStoreEventPayload(params);

  const claimedRows = await db
    .insert(kilo_pass_store_events)
    .values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: params.notification.notificationUUID,
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: providerTransactionId,
      app_account_token: appAccountToken,
      product_id: productId,
      environment: params.notification.environment,
      payload_json: payloadJson,
      processing_started_at: processingStartedAtIso,
    })
    .onConflictDoUpdate({
      target: [kilo_pass_store_events.payment_provider, kilo_pass_store_events.event_id],
      set: {
        provider_subscription_id: providerSubscriptionId,
        provider_transaction_id: providerTransactionId,
        app_account_token: appAccountToken,
        product_id: productId,
        environment: params.notification.environment,
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
      eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
      eq(kilo_pass_store_events.event_id, params.notification.notificationUUID)
    ),
  });

  return existingEvent?.processed_at ? 'already_processed' : 'in_flight';
}

/** Apple `price` is in milliunits of `currency`: ten milliunits make one cent. */
function getAppStoreUsdAmountCents(transaction: AppleStoreDecodedTransaction): number | undefined {
  if (transaction.currency !== 'USD' || transaction.price === undefined) return undefined;
  return Math.max(0, Math.round(transaction.price / 10));
}

/**
 * The store money event an Apple notification maps to. `REVOKE` (a family-sharing loss, not fraud),
 * the churn notifications (`DID_FAIL_TO_RENEW`, `EXPIRED`, `GRACE_PERIOD_EXPIRED`), and every
 * unmapped type report none.
 */
function getAppStoreBouncerReport(
  notificationType: string,
  transaction: AppleStoreDecodedTransaction
): StoreEventKind | null {
  switch (notificationType) {
    case NotificationTypeV2.CONSUMPTION_REQUEST:
      // The customer asked for a refund; the outcome is still open.
      return { type: 'store.refund_requested' };
    case NotificationTypeV2.REFUND:
      return {
        type: 'store.refund',
        reason:
          transaction.revocationReason === RevocationReason.REFUNDED_DUE_TO_ISSUE
            ? 'issue'
            : 'other',
      };
    case NotificationTypeV2.REFUND_DECLINED:
      return { type: 'store.refund_declined' };
    case NotificationTypeV2.REFUND_REVERSED:
      return { type: 'store.refund_reversed' };
    case NotificationTypeV2.SUBSCRIBED:
    case NotificationTypeV2.DID_RENEW:
      return { type: 'store.purchase', amountCents: getAppStoreUsdAmountCents(transaction) };
    default:
      return null;
  }
}

/**
 * The Kilo account that owns an App Store transaction, for a report. The SELECTs run on the passed
 * database (the caller's transaction), so the lookup is atomic with the enqueue. A query failure
 * rejects and propagates to the caller.
 */
async function resolveAppStoreCreditPackOwner(
  database: BouncerCreditEventOutboxDatabase,
  transaction: AppleStoreDecodedTransaction
): Promise<string | null> {
  const creditPackRows = await database
    .select({ kiloUserId: credit_transactions.kilo_user_id })
    .from(credit_transactions)
    .where(
      eq(
        credit_transactions.stripe_payment_id,
        storeCreditPaymentId(KiloPassPaymentProvider.AppStore, transaction.transactionId)
      )
    )
    .limit(1);
  if (creditPackRows[0]) return creditPackRows[0].kiloUserId;

  if (!transaction.appAccountToken) return null;
  const tokenRows = await database
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.app_store_account_token, transaction.appAccountToken))
    .limit(1);
  return tokenRows[0]?.id ?? null;
}

/**
 * Durably enqueues one App Store money event for bouncer on the caller's transaction, so it
 * commits atomically with `kilo_pass_store_events.processed_at`: a crash or DB error can never mark
 * the store event processed while losing the report, and a provider redelivery that hits
 * `already_processed` cannot suppress a lost enqueue. Production events for a resolved Kilo account
 * only: a store event carries no card and no client IP.
 */
async function enqueueAppStoreCreditEventToBouncer(
  database: BouncerCreditEventOutboxDatabase,
  params: {
    notification: AppleStoreDecodedNotification;
    transaction: AppleStoreDecodedTransaction;
  }
): Promise<void> {
  if (params.notification.environment !== 'Production') return;
  const report = getAppStoreBouncerReport(params.notification.notificationType, params.transaction);
  if (!report) return;
  const userId = await resolveAppStoreCreditPackOwner(database, params.transaction);
  if (!userId) return;
  const event: StoreCreditEvent = {
    ...report,
    provider: 'apple',
    eventId: params.notification.notificationUUID,
    occurredAt:
      params.notification.signedDate === undefined
        ? undefined
        : new Date(params.notification.signedDate),
    userId,
    // Consumable credit packs have no subscription chain.
    originalTransactionId: undefined,
    referenceId: params.transaction.transactionId,
    environment: 'production',
  };
  await enqueueCreditEvent(database, event);
}

export async function processAppStoreKiloPassNotification(params: {
  signedPayload: string;
  decodeNotification?: DecodeNotification;
  decodeTransaction?: DecodeTransaction;
  sendConsumptionInformation?: SendConsumptionInformation;
}): Promise<AppStoreKiloPassNotificationProcessingResult> {
  const decodeNotification = params.decodeNotification ?? decodeAppleStoreNotificationJws;
  const decodeTransaction = params.decodeTransaction ?? decodeAppleStoreTransactionJws;
  const sendConsumptionInformation =
    params.sendConsumptionInformation ?? sendAppleStoreConsumptionInformation;
  const notification = await decodeNotification(params.signedPayload);
  const transaction = notification.signedTransactionInfo
    ? await decodeTransaction(notification.signedTransactionInfo)
    : null;

  const claimedEvent = await claimStoreEventForProcessing({ notification, transaction });
  if (claimedEvent === 'already_processed') {
    return { processed: true, status: 'already_processed' };
  }
  if (claimedEvent === 'in_flight') {
    return { processed: false, status: 'in_flight' };
  }
  // Every non-credit-pack notification is recorded and acknowledged without
  // subscription lifecycle, credit, reporting, or App Store API side effects.
  if (!transaction || !getStoreCreditProductByAppleProductId(transaction.productId)) {
    await db
      .update(kilo_pass_store_events)
      .set({ processed_at: new Date().toISOString() })
      .where(
        and(
          eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
          eq(kilo_pass_store_events.event_id, notification.notificationUUID)
        )
      );
    return { processed: true };
  }

  if (transaction && notification.notificationType === NotificationTypeV2.CONSUMPTION_REQUEST) {
    const consumptionRequest = await getAppStoreRefundConsumptionRequest(transaction);
    await sendConsumptionInformation(transaction.transactionId, consumptionRequest);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreNotificationReceived,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        notificationType: notification.notificationType,
        providerSubscriptionId: transaction.originalTransactionId,
        providerTransactionId: transaction.transactionId,
        consumptionInformationSent: true,
        refundPreference: consumptionRequest.refundPreference,
        consumptionPercentage: consumptionRequest.consumptionPercentage ?? null,
      },
    });
  }

  if (transaction && REFUND_TYPES.has(notification.notificationType)) {
    await db.transaction(async tx => {
      // Serialize with a completion of the same store transaction, in either
      // order: a refund that runs first is visible to a later completion, which
      // then refuses to grant the pack at all, and a grant that runs first is
      // clawed back here. Without the lock both could read the other's absence
      // and leave the refunded credits granted.
      await lockStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [transaction.transactionId],
      });

      // A refund the store has already reinstated is superseded: the store
      // signed a reversal after it, so its credits must stay where the reversal
      // put them. A refund the store signs *after* a reversal is not superseded
      // and claws the pack back again.
      const creditPackSuperseded = await isStoreRefundDeliverySuperseded(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [transaction.transactionId],
        signedDateMs: notification.signedDate ?? null,
      });

      // A refunded credit pack is not a Kilo Pass purchase, so it is reversed
      // separately, keyed by its store transaction id. A failure here must
      // propagate: swallowing it would mark the event processed with the
      // credits still granted, and the App Store never redelivers a processed
      // event, so the clawback would be lost permanently. The reversal is
      // idempotent, so a redelivery retries it safely — the same contract as
      // the Google Play one-time refund branch. A prorated refund reverses the
      // refunded share; a full refund, a family revoke, or a missing share
      // reverses the whole pack.
      let storeCreditReversal: StoreCreditReversalResult | null = null;
      if (!creditPackSuperseded) {
        storeCreditReversal = await reverseStoreCreditPurchase(tx, {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerTransactionId: transaction.transactionId,
          refundedMilliunits:
            transaction.revocationType === RevocationType.REFUND_PRORATED &&
            transaction.revocationPercentage != null
              ? transaction.revocationPercentage
              : STORE_FULL_MILLIUNITS,
        });
      }
      const superseded = creditPackSuperseded;

      await appendKiloPassAuditLog(tx, {
        action: superseded
          ? KiloPassAuditLogAction.StoreNotificationReceived
          : KiloPassAuditLogAction.StoreSubscriptionRefunded,
        result: KiloPassAuditLogResult.Success,
        payload: {
          notificationUUID: notification.notificationUUID,
          providerSubscriptionId: transaction.originalTransactionId,
          providerTransactionId: transaction.transactionId,
          supersededByStoreReversal: creditPackSuperseded,
          storePurchaseFound: false,
          creditTransactionIds: [],
          totalReversalMicrodollars: 0,
          reversedItemKinds: [],
          storeCreditReversal,
          supersededByNewerRefundReversal: false,
        },
      });
      await enqueueAppStoreCreditEventToBouncer(tx, { notification, transaction });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: new Date().toISOString() })
        .where(
          and(
            eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
            eq(kilo_pass_store_events.event_id, notification.notificationUUID)
          )
        );
    });
    return { processed: true };
  }

  // Refund reinstatement covers consumable credit packs only.
  if (
    transaction &&
    notification.notificationType === NotificationTypeV2.REFUND_REVERSED &&
    getStoreCreditProductByAppleProductId(transaction.productId)
  ) {
    await db.transaction(async tx => {
      // Serialize with the grant and the refund of the same purchase, in either
      // order: a reversal that runs beside the refund it reverses must read the
      // clawback the refund writes, not the absence of one.
      await lockStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [transaction.transactionId],
      });

      // Apple reinstated a refund it reversed, so the pack's clawback is owed
      // back. The restore reads the clawback row itself: a purchase Kilo never
      // granted has nothing to restore, a prorated refund restores exactly its
      // own share, and a redelivered reversal is a no-op. A reversal the store
      // signed before a refund it already processed reinstates nothing, because
      // that refund is the one in force. A failure propagates so the event stays
      // unprocessed and the App Store redelivers it, the same contract as the
      // clawback above.
      const superseded = await isStoreRefundDeliverySuperseded(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [transaction.transactionId],
        signedDateMs: notification.signedDate ?? null,
      });
      let storeCreditRestoration: StoreCreditRestorationResult | null = null;
      if (!superseded && getStoreCreditProductByAppleProductId(transaction.productId)) {
        storeCreditRestoration = await restoreStoreCreditPurchase(tx, {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerTransactionId: transaction.transactionId,
        });
      }

      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StoreNotificationReceived,
        result: KiloPassAuditLogResult.Success,
        payload: {
          notificationUUID: notification.notificationUUID,
          notificationType: notification.notificationType,
          providerSubscriptionId: transaction.originalTransactionId,
          providerTransactionId: transaction.transactionId,
          supersededByStoreRefund: superseded,
          storeCreditRestoration,
        },
      });
      await enqueueAppStoreCreditEventToBouncer(tx, { notification, transaction });
      await tx
        .update(kilo_pass_store_events)
        .set({ processed_at: new Date().toISOString() })
        .where(
          and(
            eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
            eq(kilo_pass_store_events.event_id, notification.notificationUUID)
          )
        );
    });
    return { processed: true };
  }

  await db.transaction(async tx => {
    if (transaction) {
      await enqueueAppStoreCreditEventToBouncer(tx, { notification, transaction });
    }
    await tx
      .update(kilo_pass_store_events)
      .set({ processed_at: new Date().toISOString() })
      .where(
        and(
          eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
          eq(kilo_pass_store_events.event_id, notification.notificationUUID)
        )
      );
  });

  return { processed: true };
}
