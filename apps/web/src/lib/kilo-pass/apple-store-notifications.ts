import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  type ResponseBodyV2DecodedPayload,
  Subtype,
  type ConsumptionRequest,
} from '@apple/app-store-server-library';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as z from 'zod';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_store_events,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { KiloPassAuditLogAction, KiloPassAuditLogResult, KiloPassPaymentProvider } from './enums';
import { KiloPassIssuanceItemKind } from './enums';
import { appendKiloPassAuditLog } from './issuance';
import {
  decodeAppleStoreTransactionJws,
  mapAppleKiloPassTransaction,
  type AppleStoreDecodedTransaction,
  type AppleStoreEnvironment,
} from './apple-store-verifier';
import {
  createAppleStoreServerApiClient,
  createAppleStoreSignedDataVerifier,
} from './apple-store-sdk';
import { completeStoreKiloPassPurchase } from './store-subscription-completion';
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import { dayjs } from './dayjs';

export type AppleStoreDecodedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  environment: AppleStoreEnvironment;
  signedTransactionInfo?: string;
};

type DecodeNotification = (signedPayload: string) => Promise<AppleStoreDecodedNotification>;
type DecodeTransaction = (signedTransactionJws: string) => Promise<AppleStoreDecodedTransaction>;
type SendConsumptionInformation = (
  transactionId: string,
  request: ConsumptionRequest
) => Promise<void>;

const RENEWAL_TYPES = new Set<string>([
  NotificationTypeV2.DID_RENEW,
  NotificationTypeV2.SUBSCRIBED,
]);
const EXPIRED_TYPES = new Set<string>([NotificationTypeV2.EXPIRED]);
const REFUND_TYPES = new Set<string>([NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE]);
const STORE_EVENT_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

function isImmediateStorePurchaseNotification(
  notification: AppleStoreDecodedNotification
): boolean {
  return (
    RENEWAL_TYPES.has(notification.notificationType) ||
    (notification.notificationType === NotificationTypeV2.DID_CHANGE_RENEWAL_PREF &&
      notification.subtype === Subtype.UPGRADE)
  );
}

const AppleStoreNotificationPayloadSchema = z
  .object({
    notificationUUID: z.string().min(1),
    notificationType: z.string().min(1),
    subtype: z.string().optional(),
    data: z
      .object({
        environment: z.string().optional(),
        signedTransactionInfo: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function normalizeEnvironment(environment: string | undefined): AppleStoreEnvironment {
  if (environment === 'Production') return 'Production';
  return 'Sandbox';
}

async function sendAppleStoreConsumptionInformation(
  transactionId: string,
  request: ConsumptionRequest
): Promise<void> {
  await createAppleStoreServerApiClient().sendConsumptionInformation(transactionId, request);
}

function getAppStoreKiloPassRefundConsumptionRequest(): ConsumptionRequest {
  return {
    customerConsented: true,
    deliveryStatus: DeliveryStatus.DELIVERED,
    refundPreference: RefundPreference.DECLINE,
    sampleContentProvided: false,
  };
}

export async function decodeAppleStoreNotificationJws(
  signedPayload: string
): Promise<AppleStoreDecodedNotification> {
  const decoded = (await createAppleStoreSignedDataVerifier().verifyAndDecodeNotification(
    signedPayload
  )) as ResponseBodyV2DecodedPayload;

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
    signedTransactionInfo: payload.data?.signedTransactionInfo,
  };
}

async function markStoreSubscriptionEnded(
  transaction: AppleStoreDecodedTransaction
): Promise<void> {
  await db
    .update(kilo_pass_subscriptions)
    .set({
      status: 'canceled',
      cancel_at_period_end: false,
      ended_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId)
      )
    );
}

async function markStoreSubscriptionCancelingAtPeriodEnd(
  transaction: AppleStoreDecodedTransaction
): Promise<void> {
  await db
    .update(kilo_pass_subscriptions)
    .set({
      cancel_at_period_end: true,
    })
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId)
      )
    );
}

async function markStoreSubscriptionRenewing(
  transaction: AppleStoreDecodedTransaction
): Promise<void> {
  await db
    .update(kilo_pass_subscriptions)
    .set({
      cancel_at_period_end: false,
    })
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId)
      )
    );
}

async function getUserForStoreRenewal(params: {
  providerSubscriptionId: string;
  appAccountToken: string | null;
  fallbackUser?: User;
}): Promise<User | null> {
  const row = await db
    .select({ user: kilocode_users })
    .from(kilo_pass_subscriptions)
    .innerJoin(kilocode_users, eq(kilo_pass_subscriptions.kilo_user_id, kilocode_users.id))
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, params.providerSubscriptionId)
      )
    )
    .limit(1);

  if (row[0]?.user) {
    if (row[0].user.app_store_account_token !== params.appAccountToken) {
      throw new Error('App Store renewal account token does not match subscription owner');
    }
    return row[0].user;
  }

  if (params.fallbackUser) return params.fallbackUser;

  if (!params.appAccountToken) return null;

  const tokenRows = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.app_store_account_token, params.appAccountToken))
    .limit(1);

  return tokenRows[0] ?? null;
}

function getStoreEventPayload(params: {
  notification: AppleStoreDecodedNotification;
  purchase: ReturnType<typeof mapAppleKiloPassTransaction> | null;
  transaction: AppleStoreDecodedTransaction | null;
}): Record<string, unknown> {
  return redactStoreAccountLinkedJson({
    notificationType: params.notification.notificationType,
    subtype: params.notification.subtype ?? null,
    transaction: params.purchase
      ? {
          productId: params.purchase.productId,
          providerSubscriptionId: params.purchase.providerSubscriptionId,
          providerTransactionId: params.purchase.providerTransactionId,
          providerOriginalTransactionId: params.purchase.providerOriginalTransactionId,
          appAccountToken: params.purchase.appAccountToken,
          purchasedAtIso: params.purchase.purchasedAtIso,
          expiresAtIso: params.purchase.expiresAtIso,
          environment: params.purchase.environment,
          tier: params.purchase.tier,
          cadence: params.purchase.cadence,
        }
      : null,
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
  purchase: ReturnType<typeof mapAppleKiloPassTransaction> | null;
  transaction: AppleStoreDecodedTransaction | null;
}): Promise<boolean> {
  const processingStartedAtIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STORE_EVENT_CLAIM_STALE_AFTER_MS).toISOString();

  const providerSubscriptionId =
    params.purchase?.providerSubscriptionId ?? params.transaction?.originalTransactionId ?? null;
  const providerTransactionId =
    params.purchase?.providerTransactionId ?? params.transaction?.transactionId ?? null;
  const appAccountToken =
    params.purchase?.appAccountToken ?? params.transaction?.appAccountToken ?? null;
  const productId = params.purchase?.productId ?? params.transaction?.productId ?? 'unknown';
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

  return claimedRows.length > 0;
}

type CreditReversalResult = {
  storePurchaseFound: boolean;
  creditTransactionIds: string[];
  totalReversalMicrodollars: number;
  reversedItemKinds: KiloPassIssuanceItemKind[];
};

async function insertCreditReversal(
  tx: DrizzleTransaction,
  params: {
    kiloUserId: string;
    amountMicrodollars: number;
    isFree: boolean;
    description: string;
    creditCategory: string;
    originalBaselineMicrodollarsUsed: number;
  }
): Promise<{ wasInserted: boolean; creditTransactionId: string | null }> {
  const creditTransactionId = crypto.randomUUID();
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: params.kiloUserId,
      amount_microdollars: -params.amountMicrodollars,
      is_free: params.isFree,
      description: params.description,
      credit_category: params.creditCategory,
      check_category_uniqueness: true,
      original_baseline_microdollars_used: params.originalBaselineMicrodollarsUsed,
    })
    .onConflictDoNothing();

  if ((insertResult.rowCount ?? 0) === 0) {
    const existingRows = await tx
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, params.kiloUserId),
          eq(credit_transactions.credit_category, params.creditCategory)
        )
      )
      .limit(1);
    return { wasInserted: false, creditTransactionId: existingRows[0]?.id ?? null };
  }

  await tx
    .update(kilocode_users)
    .set({
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${params.amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, params.kiloUserId));

  return { wasInserted: true, creditTransactionId };
}

function getRefundReversalDescription(kind: KiloPassIssuanceItemKind): string {
  if (kind === KiloPassIssuanceItemKind.Base) {
    return 'App Store Kilo Pass refund clawback';
  }
  if (kind === KiloPassIssuanceItemKind.Bonus) {
    return 'App Store Kilo Pass bonus refund clawback';
  }
  return 'App Store Kilo Pass promo refund clawback';
}

async function reverseAppStoreRefundCredits(
  transaction: AppleStoreDecodedTransaction
): Promise<CreditReversalResult> {
  return db.transaction(async tx => {
    const storePurchase = await tx.query.kilo_pass_store_purchases.findFirst({
      where: and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_store_purchases.provider_transaction_id, transaction.transactionId)
      ),
    });

    if (!storePurchase) {
      return {
        storePurchaseFound: false,
        creditTransactionIds: [],
        totalReversalMicrodollars: 0,
        reversedItemKinds: [],
      };
    }

    const userRows = await tx
      .select({ microdollarsUsed: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, storePurchase.kilo_user_id))
      .for('update')
      .limit(1);
    const user = userRows[0];
    if (!user) {
      throw new Error('App Store refund cannot find the subscribed user');
    }

    const issueMonth = dayjs(storePurchase.purchased_at).utc().format('YYYY-MM-01');
    const issuance = await tx.query.kilo_pass_issuances.findFirst({
      where: and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, storePurchase.kilo_pass_subscription_id),
        eq(kilo_pass_issuances.issue_month, issueMonth)
      ),
    });

    if (!issuance) {
      return {
        storePurchaseFound: true,
        creditTransactionIds: [],
        totalReversalMicrodollars: 0,
        reversedItemKinds: [],
      };
    }

    const issuedItems = await tx
      .select({
        itemId: kilo_pass_issuance_items.id,
        kind: kilo_pass_issuance_items.kind,
        amountMicrodollars: credit_transactions.amount_microdollars,
        isFree: credit_transactions.is_free,
      })
      .from(kilo_pass_issuance_items)
      .innerJoin(
        credit_transactions,
        eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
      )
      .where(
        and(
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance.id),
          inArray(kilo_pass_issuance_items.kind, [
            KiloPassIssuanceItemKind.Base,
            KiloPassIssuanceItemKind.Bonus,
            KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
          ])
        )
      );

    const creditTransactionIds: string[] = [];
    const reversedItemKinds: KiloPassIssuanceItemKind[] = [];
    let totalReversalMicrodollars = 0;
    for (const item of issuedItems) {
      if (item.amountMicrodollars <= 0) {
        continue;
      }

      const reversal = await insertCreditReversal(tx, {
        kiloUserId: storePurchase.kilo_user_id,
        amountMicrodollars: item.amountMicrodollars,
        isFree: item.isFree,
        description: getRefundReversalDescription(item.kind),
        creditCategory: `kilo-pass-store-refund:${KiloPassPaymentProvider.AppStore}:${transaction.transactionId}:${item.kind}:${item.itemId}`,
        originalBaselineMicrodollarsUsed: user.microdollarsUsed,
      });
      if (reversal.creditTransactionId) {
        creditTransactionIds.push(reversal.creditTransactionId);
      }
      if (reversal.wasInserted) {
        totalReversalMicrodollars += item.amountMicrodollars;
        reversedItemKinds.push(item.kind);
      }
    }

    return {
      storePurchaseFound: true,
      creditTransactionIds,
      totalReversalMicrodollars,
      reversedItemKinds,
    };
  });
}

export async function processAppStoreKiloPassNotification(params: {
  signedPayload: string;
  userForRenewal?: User;
  decodeNotification?: DecodeNotification;
  decodeTransaction?: DecodeTransaction;
  sendConsumptionInformation?: SendConsumptionInformation;
}): Promise<{ processed: boolean }> {
  const decodeNotification = params.decodeNotification ?? decodeAppleStoreNotificationJws;
  const decodeTransaction = params.decodeTransaction ?? decodeAppleStoreTransactionJws;
  const sendConsumptionInformation =
    params.sendConsumptionInformation ?? sendAppleStoreConsumptionInformation;
  const notification = await decodeNotification(params.signedPayload);
  const transaction = notification.signedTransactionInfo
    ? await decodeTransaction(notification.signedTransactionInfo)
    : null;
  const isRefundNotification = REFUND_TYPES.has(notification.notificationType);
  const purchase =
    transaction && !isRefundNotification && isImmediateStorePurchaseNotification(notification)
      ? mapAppleKiloPassTransaction(transaction)
      : null;

  const claimedEvent = await claimStoreEventForProcessing({ notification, purchase, transaction });
  if (!claimedEvent) {
    return { processed: false };
  }

  if (purchase && isImmediateStorePurchaseNotification(notification)) {
    const user = await getUserForStoreRenewal({
      providerSubscriptionId: purchase.providerSubscriptionId,
      appAccountToken: purchase.appAccountToken,
      fallbackUser: params.userForRenewal,
    });
    if (!user) {
      if (notification.notificationType !== NotificationTypeV2.SUBSCRIBED) {
        throw new Error(
          'App Store renewal notification cannot create a subscription without a user'
        );
      }
    } else {
      await completeStoreKiloPassPurchase({ user, purchase });
      await appendKiloPassAuditLog(db, {
        action: KiloPassAuditLogAction.StoreSubscriptionRenewed,
        result: KiloPassAuditLogResult.Success,
        kiloUserId: user.id,
        payload: {
          notificationUUID: notification.notificationUUID,
          providerSubscriptionId: purchase.providerSubscriptionId,
        },
      });
    }
  }

  if (transaction && EXPIRED_TYPES.has(notification.notificationType)) {
    await markStoreSubscriptionEnded(transaction);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionExpired,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        providerSubscriptionId: transaction.originalTransactionId,
      },
    });
  }

  if (transaction && notification.notificationType === NotificationTypeV2.DID_FAIL_TO_RENEW) {
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreNotificationReceived,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        notificationType: notification.notificationType,
        providerSubscriptionId: transaction.originalTransactionId,
      },
    });
  }

  if (transaction && notification.notificationType === NotificationTypeV2.CONSUMPTION_REQUEST) {
    const consumptionRequest = getAppStoreKiloPassRefundConsumptionRequest();
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
      },
    });
  }

  if (
    transaction &&
    notification.notificationType === NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS &&
    (notification.subtype === Subtype.AUTO_RENEW_DISABLED ||
      notification.subtype === Subtype.AUTO_RENEW_ENABLED)
  ) {
    if (notification.subtype === Subtype.AUTO_RENEW_DISABLED) {
      await markStoreSubscriptionCancelingAtPeriodEnd(transaction);
    } else {
      await markStoreSubscriptionRenewing(transaction);
    }
    await appendKiloPassAuditLog(db, {
      action:
        notification.subtype === Subtype.AUTO_RENEW_DISABLED
          ? KiloPassAuditLogAction.StoreSubscriptionCanceled
          : KiloPassAuditLogAction.StoreSubscriptionRenewed,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        notificationSubtype: notification.subtype,
        providerSubscriptionId: transaction.originalTransactionId,
      },
    });
  }

  if (transaction && REFUND_TYPES.has(notification.notificationType)) {
    const reversal = await reverseAppStoreRefundCredits(transaction);
    await markStoreSubscriptionEnded(transaction);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        providerSubscriptionId: transaction.originalTransactionId,
        providerTransactionId: transaction.transactionId,
        storePurchaseFound: reversal.storePurchaseFound,
        creditTransactionIds: reversal.creditTransactionIds,
        totalReversalMicrodollars: reversal.totalReversalMicrodollars,
        reversedItemKinds: reversal.reversedItemKinds,
      },
    });
  }

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
