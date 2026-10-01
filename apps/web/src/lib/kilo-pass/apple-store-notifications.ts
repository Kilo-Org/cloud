import {
  DeliveryStatus,
  NotificationTypeV2,
  RefundPreference,
  RevocationReason,
  Subtype,
  type ConsumptionRequest,
} from '@apple/app-store-server-library';
import { and, eq, inArray, like, notInArray, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
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
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassPaymentProvider,
} from '@/lib/kilo-pass/enums';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import {
  decodeAppleStoreTransactionJws,
  mapAppleKiloPassTransaction,
  normalizeEnvironment,
  type AppleStoreDecodedTransaction,
  type AppleStoreEnvironment,
} from './apple-store-verifier';
import {
  createAppleStoreServerApiClient,
  createAppleStoreSignedDataVerifier,
} from './apple-store-sdk';
import {
  completeStoreKiloPassPurchase,
  isStorePurchaseMismatchError,
  type CompleteStoreKiloPassPurchaseResult,
} from './store-subscription-completion';
import { runAfterResponse, trackKiloPassPurchaseCompleted } from '@/lib/kilo-pass/posthog-tracking';
import { reportCreditEvent, type StoreEventKind } from '@/lib/bouncer/client';
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type DbOrTx = DrizzleTransaction | typeof db;

export type AppleStoreDecodedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  /** The App Store `signedDate`, in milliseconds since the epoch. */
  signedDate?: number;
  environment: AppleStoreEnvironment;
  signedTransactionInfo?: string;
};

type DecodeNotification = (signedPayload: string) => Promise<AppleStoreDecodedNotification>;
type DecodeTransaction = (signedTransactionJws: string) => Promise<AppleStoreDecodedTransaction>;
type SendConsumptionInformation = (
  transactionId: string,
  request: ConsumptionRequest
) => Promise<void>;
type EndStoreSubscription = (
  dbOrTx: DbOrTx,
  transaction: AppleStoreDecodedTransaction
) => Promise<void>;
type StoreEventClaimStatus = 'claimed' | 'already_processed' | 'in_flight';
export type AppStoreKiloPassNotificationProcessingResult =
  | { processed: true }
  | { processed: true; status: 'already_processed' }
  | { processed: false; status: 'in_flight' };

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
    signedDate: payload.signedDate,
    environment: normalizeEnvironment(payload.data?.environment),
    signedTransactionInfo: payload.data?.signedTransactionInfo,
  };
}

export async function markStoreSubscriptionEnded(
  dbOrTx: DbOrTx,
  transaction: AppleStoreDecodedTransaction
): Promise<void> {
  await dbOrTx
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

/**
 * Undoes the `canceled` state a refund wrote. Only a subscription whose paid period is still
 * running is entitled again, and only an ended row is reopened: a reversal must not overwrite a
 * state another notification already set. A user holds at most one Kilo Pass, so a user who bought
 * another pass after the refund keeps that pass and this row stays ended.
 */
async function reopenStoreSubscription(
  dbOrTx: DbOrTx,
  transaction: AppleStoreDecodedTransaction
): Promise<boolean> {
  if (transaction.expiresDate == null || transaction.expiresDate <= Date.now()) {
    return false;
  }
  const ended = await dbOrTx
    .select({
      id: kilo_pass_subscriptions.id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
    })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId),
        inArray(kilo_pass_subscriptions.status, ['canceled', 'unpaid', 'incomplete_expired'])
      )
    )
    .limit(1);
  const row = ended[0];
  if (!row) return false;

  const otherActive = await dbOrTx
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.kilo_user_id, row.kiloUserId),
        sql`${kilo_pass_subscriptions.id} <> ${row.id}`,
        notInArray(kilo_pass_subscriptions.status, ['canceled', 'unpaid', 'incomplete_expired'])
      )
    )
    .limit(1);
  if (otherActive.length > 0) return false;

  await dbOrTx
    .update(kilo_pass_subscriptions)
    .set({ status: 'active', ended_at: null })
    .where(eq(kilo_pass_subscriptions.id, row.id));
  return true;
}

async function getUserForStoreRenewal(params: {
  providerSubscriptionId: string;
  appAccountToken: string | null;
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
    signedDate: params.notification.signedDate ?? null,
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
}): Promise<StoreEventClaimStatus> {
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

type CreditReversalResult = {
  storePurchaseFound: boolean;
  /** A newer `REFUND_REVERSED` already settled this transaction, so the refund changed nothing. */
  superseded: boolean;
  creditTransactionIds: string[];
  totalReversalMicrodollars: number;
  reversedItemKinds: KiloPassIssuanceItemKind[];
};

/**
 * Inserts one refund clawback (negative amount) or refund restoration (positive amount) and moves
 * `total_microdollars_acquired` by the same amount. The credit category is unique per user, so a
 * repeated category inserts nothing and returns the existing row.
 */
async function insertCreditAdjustment(
  tx: DrizzleTransaction,
  params: {
    kiloUserId: string;
    signedAmountMicrodollars: number;
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
      amount_microdollars: params.signedAmountMicrodollars,
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
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${params.signedAmountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, params.kiloUserId));

  return { wasInserted: true, creditTransactionId };
}

/**
 * A clawback category is `<clawback prefix><transactionId>:<kind>:<itemId>` for the first refund
 * of an item and `…:<itemId>:r<n>` for the refund after the n-th reversal. Its restoration has the
 * same category under the restoration prefix, so each clawback pairs with at most one restoration.
 */
const APP_STORE_REFUND_CLAWBACK_CATEGORY_PREFIX = `kilo-pass-store-refund:${KiloPassPaymentProvider.AppStore}:`;
const APP_STORE_REFUND_RESTORATION_CATEGORY_PREFIX = `kilo-pass-store-refund-reversal:${KiloPassPaymentProvider.AppStore}:`;

type RefundLedgerRow = {
  creditTransactionId: string;
  amountMicrodollars: number;
  isFree: boolean;
  description: string | null;
  /** The category without the clawback or restoration prefix: `<transactionId>:<kind>:<itemId>…`. */
  cycleKey: string;
};

/** The clawback rows of one transaction, and the cycle keys that a restoration already settled. */
async function readAppStoreRefundLedger(
  tx: DrizzleTransaction,
  kiloUserId: string,
  transactionId: string
): Promise<{ clawbacks: RefundLedgerRow[]; restoredCycleKeys: Set<string> }> {
  const clawbackPrefix = `${APP_STORE_REFUND_CLAWBACK_CATEGORY_PREFIX}${transactionId}:`;
  const restorationPrefix = `${APP_STORE_REFUND_RESTORATION_CATEGORY_PREFIX}${transactionId}:`;
  const rows = await tx
    .select({
      creditTransactionId: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      isFree: credit_transactions.is_free,
      description: credit_transactions.description,
      creditCategory: credit_transactions.credit_category,
    })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, kiloUserId),
        or(
          like(credit_transactions.credit_category, `${clawbackPrefix}%`),
          like(credit_transactions.credit_category, `${restorationPrefix}%`)
        )
      )
    );

  const clawbacks: RefundLedgerRow[] = [];
  const restoredCycleKeys = new Set<string>();
  for (const row of rows) {
    const category = row.creditCategory ?? '';
    if (category.startsWith(APP_STORE_REFUND_CLAWBACK_CATEGORY_PREFIX)) {
      clawbacks.push({
        ...row,
        cycleKey: category.slice(APP_STORE_REFUND_CLAWBACK_CATEGORY_PREFIX.length),
      });
    } else {
      restoredCycleKeys.add(category.slice(APP_STORE_REFUND_RESTORATION_CATEGORY_PREFIX.length));
    }
  }
  return { clawbacks, restoredCycleKeys };
}

/** The issuance item kind in a cycle key `<transactionId>:<kind>:<itemId>…`. */
function getRefundCycleItemKind(cycleKey: string): KiloPassIssuanceItemKind | null {
  const segment = cycleKey.split(':')[1];
  const kinds: string[] = Object.values(KiloPassIssuanceItemKind);
  return segment !== undefined && kinds.includes(segment)
    ? (segment as KiloPassIssuanceItemKind)
    : null;
}

/**
 * The store time of an App Store event row: its `signedDate`, or its claim time for a row written
 * before the row kept `signedDate`.
 */
const appStoreEventTimeMs = sql<number>`COALESCE(
  (${kilo_pass_store_events.payload_json}->>'signedDate')::double precision,
  EXTRACT(EPOCH FROM ${kilo_pass_store_events.created_at}) * 1000
)`;

/**
 * True when a processed event of `notificationTypes` for this transaction is newer in store time
 * than `eventTimeMs`. The newest refund or refund reversal decides the state, so an older event
 * that arrives late changes nothing.
 */
async function hasNewerAppStoreRefundEvent(
  dbOrTx: DbOrTx,
  params: { transactionId: string; notificationTypes: readonly string[]; eventTimeMs: number }
): Promise<boolean> {
  const rows = await dbOrTx
    .select({ id: kilo_pass_store_events.id })
    .from(kilo_pass_store_events)
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_store_events.provider_transaction_id, params.transactionId),
        sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
        sql`(${kilo_pass_store_events.payload_json}->>'notificationType') IN (${sql.join(
          params.notificationTypes.map(type => sql`${type}`),
          sql`, `
        )})`,
        sql`${appStoreEventTimeMs} > ${params.eventTimeMs}`
      )
    )
    .limit(1);
  return rows.length > 0;
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

function getAppStoreProviderPaymentId(providerTransactionId: string): string {
  return `kilo-pass:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`;
}

function getAppStoreUpgradeBaseCreditCategory(providerTransactionId: string): string {
  return `kilo-pass-upgrade-base:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`;
}

async function reverseAppStoreRefundCredits(
  tx: DrizzleTransaction,
  transaction: AppleStoreDecodedTransaction,
  eventTimeMs: number
): Promise<CreditReversalResult> {
  const storePurchase = await tx.query.kilo_pass_store_purchases.findFirst({
    where: and(
      eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.AppStore),
      eq(kilo_pass_store_purchases.provider_transaction_id, transaction.transactionId)
    ),
  });

  // The reversal path takes the same user lock first, so the newer-event check below sees a
  // reversal that committed while this refund waited.
  const userRows = storePurchase
    ? await tx
        .select({ microdollarsUsed: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, storePurchase.kilo_user_id))
        .for('update')
        .limit(1)
    : [];
  const superseded = await hasNewerAppStoreRefundEvent(tx, {
    transactionId: transaction.transactionId,
    notificationTypes: [NotificationTypeV2.REFUND_REVERSED],
    eventTimeMs,
  });

  if (!storePurchase || superseded) {
    return {
      storePurchaseFound: storePurchase !== undefined,
      superseded,
      creditTransactionIds: [],
      totalReversalMicrodollars: 0,
      reversedItemKinds: [],
    };
  }

  const user = userRows[0];
  if (!user) {
    throw new Error('App Store refund cannot find the subscribed user');
  }
  const ledger = await readAppStoreRefundLedger(
    tx,
    storePurchase.kilo_user_id,
    transaction.transactionId
  );
  const ownedBaseCreditRows = await tx
    .select({
      creditTransactionId: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      isFree: credit_transactions.is_free,
    })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, storePurchase.kilo_user_id),
        or(
          eq(
            credit_transactions.stripe_payment_id,
            getAppStoreProviderPaymentId(transaction.transactionId)
          ),
          eq(
            credit_transactions.credit_category,
            getAppStoreUpgradeBaseCreditCategory(transaction.transactionId)
          )
        )
      )
    )
    .limit(1);

  const ownedBaseCredit = ownedBaseCreditRows[0] ?? null;

  const issueMonth = dayjs(storePurchase.purchased_at).utc().format('YYYY-MM-01');
  const issuance = await tx.query.kilo_pass_issuances.findFirst({
    where: and(
      eq(kilo_pass_issuances.kilo_pass_subscription_id, storePurchase.kilo_pass_subscription_id),
      eq(kilo_pass_issuances.issue_month, issueMonth)
    ),
  });

  const issuedItems: {
    itemId: string;
    kind: KiloPassIssuanceItemKind;
    amountMicrodollars: number;
    isFree: boolean;
  }[] = [];

  if (ownedBaseCredit) {
    issuedItems.push({
      itemId: ownedBaseCredit.creditTransactionId,
      kind: KiloPassIssuanceItemKind.Base,
      amountMicrodollars: ownedBaseCredit.amountMicrodollars,
      isFree: ownedBaseCredit.isFree,
    });
  }

  if (issuance) {
    const currentBaseItemRows = await tx
      .select({ itemId: kilo_pass_issuance_items.id })
      .from(kilo_pass_issuance_items)
      .innerJoin(
        credit_transactions,
        eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
      )
      .where(
        and(
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance.id),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base),
          or(
            eq(
              credit_transactions.stripe_payment_id,
              getAppStoreProviderPaymentId(transaction.transactionId)
            ),
            eq(
              credit_transactions.credit_category,
              getAppStoreUpgradeBaseCreditCategory(transaction.transactionId)
            )
          )
        )
      )
      .limit(1);

    if (currentBaseItemRows[0]) {
      const bonusItems = await tx
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
              KiloPassIssuanceItemKind.Bonus,
              KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
            ])
          )
        );
      issuedItems.push(...bonusItems);
    }
  }

  const creditTransactionIds: string[] = [];
  const reversedItemKinds: KiloPassIssuanceItemKind[] = [];
  let totalReversalMicrodollars = 0;
  for (const item of issuedItems) {
    // Reverse what Kilo granted, never the App Store price. Apple returns the full
    // charge to the customer and reverses its own commission, so clawing back the
    // store price would leave a customer who spent nothing at minus the store margin.
    const reversalAmountMicrodollars = item.amountMicrodollars;

    if (reversalAmountMicrodollars <= 0) {
      continue;
    }

    // An item has one clawback per refund cycle. An open clawback (no restoration yet) means a
    // redelivered refund, so it is reported and nothing is inserted. After n restored cycles the
    // next refund writes cycle n under its own category.
    const itemKey = `${transaction.transactionId}:${item.kind}:${item.itemId}`;
    const itemClawbacks = ledger.clawbacks.filter(
      row => row.cycleKey === itemKey || row.cycleKey.startsWith(`${itemKey}:r`)
    );
    const openClawback = itemClawbacks.find(row => !ledger.restoredCycleKeys.has(row.cycleKey));
    if (openClawback) {
      creditTransactionIds.push(openClawback.creditTransactionId);
      continue;
    }
    const cycle = itemClawbacks.length;
    const reversal = await insertCreditAdjustment(tx, {
      kiloUserId: storePurchase.kilo_user_id,
      signedAmountMicrodollars: -reversalAmountMicrodollars,
      isFree: item.isFree,
      description: getRefundReversalDescription(item.kind),
      creditCategory: `${APP_STORE_REFUND_CLAWBACK_CATEGORY_PREFIX}${itemKey}${cycle === 0 ? '' : `:r${cycle}`}`,
      originalBaselineMicrodollarsUsed: user.microdollarsUsed,
    });
    if (reversal.creditTransactionId) {
      creditTransactionIds.push(reversal.creditTransactionId);
    }
    if (reversal.wasInserted) {
      totalReversalMicrodollars += reversalAmountMicrodollars;
      reversedItemKinds.push(item.kind);
    }
  }

  return {
    storePurchaseFound: true,
    superseded: false,
    creditTransactionIds,
    totalReversalMicrodollars,
    reversedItemKinds,
  };
}

type CreditRestorationResult = {
  storePurchaseFound: boolean;
  /** A newer `REFUND` or `REVOKE` already settled this transaction, so the reversal changed nothing. */
  superseded: boolean;
  restoredCreditTransactionIds: string[];
  totalRestoredMicrodollars: number;
  restoredItemKinds: KiloPassIssuanceItemKind[];
};

function getRefundRestorationDescription(kind: KiloPassIssuanceItemKind | null): string {
  if (kind === KiloPassIssuanceItemKind.Base) {
    return 'App Store Kilo Pass refund reversal';
  }
  if (kind === KiloPassIssuanceItemKind.Bonus) {
    return 'App Store Kilo Pass bonus refund reversal';
  }
  return 'App Store Kilo Pass promo refund reversal';
}

/**
 * Puts back exactly the credits each open clawback removed, one positive credit transaction per
 * clawback row. A restored clawback is closed, so a redelivered `REFUND_REVERSED` inserts nothing.
 */
async function restoreAppStoreRefundCredits(
  tx: DrizzleTransaction,
  transaction: AppleStoreDecodedTransaction,
  eventTimeMs: number
): Promise<CreditRestorationResult> {
  const storePurchase = await tx.query.kilo_pass_store_purchases.findFirst({
    where: and(
      eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.AppStore),
      eq(kilo_pass_store_purchases.provider_transaction_id, transaction.transactionId)
    ),
  });

  // The refund path takes the same user lock first, so the newer-event check below sees a refund
  // that committed while this reversal waited.
  const userRows = storePurchase
    ? await tx
        .select({ microdollarsUsed: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, storePurchase.kilo_user_id))
        .for('update')
        .limit(1)
    : [];
  const superseded = await hasNewerAppStoreRefundEvent(tx, {
    transactionId: transaction.transactionId,
    notificationTypes: Array.from(REFUND_TYPES),
    eventTimeMs,
  });

  if (!storePurchase || superseded) {
    return {
      storePurchaseFound: storePurchase !== undefined,
      superseded,
      restoredCreditTransactionIds: [],
      totalRestoredMicrodollars: 0,
      restoredItemKinds: [],
    };
  }

  const user = userRows[0];
  if (!user) {
    throw new Error('App Store refund reversal cannot find the subscribed user');
  }
  const ledger = await readAppStoreRefundLedger(
    tx,
    storePurchase.kilo_user_id,
    transaction.transactionId
  );

  const restoredCreditTransactionIds: string[] = [];
  const restoredItemKinds: KiloPassIssuanceItemKind[] = [];
  let totalRestoredMicrodollars = 0;
  for (const clawback of ledger.clawbacks) {
    const amountMicrodollars = -clawback.amountMicrodollars;
    if (amountMicrodollars <= 0 || ledger.restoredCycleKeys.has(clawback.cycleKey)) {
      continue;
    }

    const itemKind = getRefundCycleItemKind(clawback.cycleKey);
    const restoration = await insertCreditAdjustment(tx, {
      kiloUserId: storePurchase.kilo_user_id,
      signedAmountMicrodollars: amountMicrodollars,
      isFree: clawback.isFree,
      description: getRefundRestorationDescription(itemKind),
      creditCategory: `${APP_STORE_REFUND_RESTORATION_CATEGORY_PREFIX}${clawback.cycleKey}`,
      originalBaselineMicrodollarsUsed: user.microdollarsUsed,
    });
    if (restoration.creditTransactionId) {
      restoredCreditTransactionIds.push(restoration.creditTransactionId);
    }
    if (restoration.wasInserted) {
      totalRestoredMicrodollars += amountMicrodollars;
      if (itemKind) {
        restoredItemKinds.push(itemKind);
      }
    }
  }

  return {
    storePurchaseFound: true,
    superseded: false,
    restoredCreditTransactionIds,
    totalRestoredMicrodollars,
    restoredItemKinds,
  };
}

type TerminalStoreEvent = {
  eventId: string;
  notificationType: string | null;
  terminalTimestampMs: number | null;
};

async function findProcessedTerminalStoreEventForPurchase(
  purchase: ReturnType<typeof mapAppleKiloPassTransaction>
): Promise<TerminalStoreEvent | null> {
  const terminalNotificationTypeFilter = sql`(${kilo_pass_store_events.payload_json}->>'notificationType') IN (${sql.join(
    Array.from(REFUND_TYPES).map(type => sql`${type}`),
    sql`, `
  )})`;
  const terminalTimestampMs = sql<number | null>`COALESCE(
    (${kilo_pass_store_events.payload_json}->'rawTransaction'->>'revocationDate')::double precision,
    (${kilo_pass_store_events.payload_json}->'rawTransaction'->>'purchaseDate')::double precision
  )`;
  const purchaseTimestampMs = Date.parse(purchase.purchasedAtIso);

  const terminalEvents = await db
    .select({
      eventId: kilo_pass_store_events.event_id,
      notificationType: sql<
        string | null
      >`${kilo_pass_store_events.payload_json}->>'notificationType'`,
      terminalTimestampMs,
    })
    .from(kilo_pass_store_events)
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
        sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
        terminalNotificationTypeFilter,
        or(
          eq(kilo_pass_store_events.provider_transaction_id, purchase.providerTransactionId),
          and(
            eq(kilo_pass_store_events.provider_subscription_id, purchase.providerSubscriptionId),
            sql`${terminalTimestampMs} >= ${purchaseTimestampMs}`
          )
        )
      )
    )
    .limit(1);

  return terminalEvents[0] ?? null;
}

/** Apple `price` is in milliunits of `currency`: ten milliunits make one cent. */
function getAppStoreUsdAmountCents(transaction: AppleStoreDecodedTransaction): number | undefined {
  if (transaction.currency !== 'USD' || transaction.price === undefined) return undefined;
  return Math.max(0, Math.round(transaction.price / 10));
}

/**
 * The store money event an Apple notification maps to. `REVOKE`, the churn notifications
 * (`DID_FAIL_TO_RENEW`, `EXPIRED`, `GRACE_PERIOD_EXPIRED`), and every unmapped type report none.
 */
function getAppStoreBouncerReport(
  notificationType: string,
  transaction: AppleStoreDecodedTransaction
): StoreEventKind | null {
  switch (notificationType) {
    case NotificationTypeV2.CONSUMPTION_REQUEST:
      // The customer asked for a refund; the outcome is still open.
      return { type: 'store.refund', reason: 'requested' };
    case NotificationTypeV2.REFUND:
      return {
        type: 'store.refund',
        reason:
          transaction.revocationReason === RevocationReason.REFUNDED_DUE_TO_ISSUE
            ? 'issue'
            : 'other',
      };
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
 * The Kilo account that owns an App Store transaction, for a report. A query failure rejects;
 * `runAfterResponse` captures it, so it never reaches the store flow.
 */
async function resolveAppStoreKiloPassOwner(
  transaction: AppleStoreDecodedTransaction
): Promise<string | null> {
  const subscriptionRows = await db
    .select({ kiloUserId: kilo_pass_subscriptions.kilo_user_id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId)
      )
    )
    .limit(1);
  if (subscriptionRows[0]) return subscriptionRows[0].kiloUserId;

  const purchaseRows = await db
    .select({ kiloUserId: kilo_pass_store_purchases.kilo_user_id })
    .from(kilo_pass_store_purchases)
    .where(
      and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.AppStore),
        eq(kilo_pass_store_purchases.provider_transaction_id, transaction.transactionId)
      )
    )
    .limit(1);
  if (purchaseRows[0]) return purchaseRows[0].kiloUserId;

  if (!transaction.appAccountToken) return null;
  const tokenRows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.app_store_account_token, transaction.appAccountToken))
    .limit(1);
  return tokenRows[0]?.id ?? null;
}

/**
 * Reports one App Store money event to bouncer. Production events for a resolved Kilo account only:
 * a store event carries no card and no client IP. Call it from `after()`, post-commit.
 */
async function reportAppStoreCreditEventToBouncer(params: {
  notification: AppleStoreDecodedNotification;
  transaction: AppleStoreDecodedTransaction;
}): Promise<void> {
  if (params.notification.environment !== 'Production') return;
  const report = getAppStoreBouncerReport(params.notification.notificationType, params.transaction);
  if (!report) return;
  const userId = await resolveAppStoreKiloPassOwner(params.transaction);
  if (!userId) return;
  await reportCreditEvent({
    ...report,
    provider: 'apple',
    eventId: params.notification.notificationUUID,
    occurredAt:
      params.notification.signedDate === undefined
        ? undefined
        : new Date(params.notification.signedDate),
    userId,
    storeAccountKey: params.transaction.originalTransactionId,
    referenceId: params.transaction.transactionId,
    environment: 'production',
  });
}

export async function processAppStoreKiloPassNotification(params: {
  signedPayload: string;
  decodeNotification?: DecodeNotification;
  decodeTransaction?: DecodeTransaction;
  sendConsumptionInformation?: SendConsumptionInformation;
  endStoreSubscription?: EndStoreSubscription;
}): Promise<AppStoreKiloPassNotificationProcessingResult> {
  const decodeNotification = params.decodeNotification ?? decodeAppleStoreNotificationJws;
  const decodeTransaction = params.decodeTransaction ?? decodeAppleStoreTransactionJws;
  const sendConsumptionInformation =
    params.sendConsumptionInformation ?? sendAppleStoreConsumptionInformation;
  const endStoreSubscription = params.endStoreSubscription ?? markStoreSubscriptionEnded;
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
  if (claimedEvent === 'already_processed') {
    return { processed: true, status: 'already_processed' };
  }
  if (claimedEvent === 'in_flight') {
    return { processed: false, status: 'in_flight' };
  }
  // Apple always signs `signedDate`; arrival time orders a payload without one, as its row does.
  const eventTimeMs = notification.signedDate ?? Date.now();

  if (transaction && purchase && isImmediateStorePurchaseNotification(notification)) {
    const terminalEvent = await findProcessedTerminalStoreEventForPurchase(purchase);
    if (terminalEvent) {
      await db.transaction(async tx => {
        await appendKiloPassAuditLog(tx, {
          action: KiloPassAuditLogAction.StoreNotificationReceived,
          result: KiloPassAuditLogResult.Success,
          payload: {
            notificationUUID: notification.notificationUUID,
            notificationType: notification.notificationType,
            providerSubscriptionId: purchase.providerSubscriptionId,
            providerTransactionId: purchase.providerTransactionId,
            skippedStorePurchaseCompletion: true,
            terminalEventId: terminalEvent.eventId,
            terminalNotificationType: terminalEvent.notificationType,
            terminalTimestampMs: terminalEvent.terminalTimestampMs,
          },
        });
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

    const user = await getUserForStoreRenewal({
      providerSubscriptionId: purchase.providerSubscriptionId,
      appAccountToken: purchase.appAccountToken,
    });
    if (!user) {
      if (notification.notificationType !== NotificationTypeV2.SUBSCRIBED) {
        throw new Error(
          'App Store renewal notification cannot create a subscription without a user'
        );
      }
    } else {
      let completionResult: CompleteStoreKiloPassPurchaseResult | null = null;
      let purchaseMismatch = false;
      await db.transaction(async tx => {
        try {
          completionResult = await completeStoreKiloPassPurchase({ dbOrTx: tx, user, purchase });
        } catch (error) {
          // A permanent provider/user mismatch settles `failed` inside the
          // completion, so this event must be marked processed and never retried.
          if (isStorePurchaseMismatchError(error)) {
            purchaseMismatch = true;
            await tx
              .update(kilo_pass_store_events)
              .set({ processed_at: new Date().toISOString() })
              .where(
                and(
                  eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
                  eq(kilo_pass_store_events.event_id, notification.notificationUUID)
                )
              );
            return;
          }
          throw error;
        }
        await appendKiloPassAuditLog(tx, {
          action: KiloPassAuditLogAction.StoreSubscriptionRenewed,
          result: KiloPassAuditLogResult.Success,
          kiloUserId: user.id,
          payload: {
            notificationUUID: notification.notificationUUID,
            providerSubscriptionId: purchase.providerSubscriptionId,
          },
        });
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
      if (purchaseMismatch) {
        return { processed: true };
      }
      // Post-commit only — never capture inside the transaction.
      const trackedResult = completionResult as CompleteStoreKiloPassPurchaseResult | null;
      if (trackedResult && !trackedResult.alreadyProcessed) {
        await runAfterResponse(async () => {
          trackKiloPassPurchaseCompleted({
            channel: 'app_store',
            distinctId: user.google_user_email,
            userId: user.id,
            tier: trackedResult.tier,
            cadence: trackedResult.cadence,
            purchaseKind: trackedResult.purchaseKind,
            providerTransactionId: purchase.providerTransactionId,
            productId: purchase.productId,
            environment: purchase.environment,
          });
        });
      }
      await runAfterResponse(() =>
        reportAppStoreCreditEventToBouncer({ notification, transaction })
      );
      return { processed: true };
    }
  }

  if (transaction && EXPIRED_TYPES.has(notification.notificationType)) {
    await markStoreSubscriptionEnded(db, transaction);
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

  if (transaction && notification.notificationType === NotificationTypeV2.REFUND_REVERSED) {
    await db.transaction(async tx => {
      let restoration: CreditRestorationResult | null = null;
      try {
        restoration = await restoreAppStoreRefundCredits(tx, transaction, eventTimeMs);
      } catch (error) {
        captureException(error, {
          tags: { area: 'kilo-pass', operation: 'restore-app-store-refund-credits' },
          extra: {
            notificationUuid: notification.notificationUUID,
            originalTransactionId: transaction.originalTransactionId,
            transactionId: transaction.transactionId,
          },
        });
        // A failed restoration must not settle as processed: Apple redelivers the notification,
        // and the customer's credits would otherwise stay clawed back forever.
        throw error;
      }
      // A newer refund already ended the subscription and took the credits back; keep that state.
      const subscriptionReopened = restoration.superseded
        ? false
        : await reopenStoreSubscription(tx, transaction);
      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StoreNotificationReceived,
        result: KiloPassAuditLogResult.Success,
        payload: {
          notificationUUID: notification.notificationUUID,
          notificationType: notification.notificationType,
          providerSubscriptionId: transaction.originalTransactionId,
          providerTransactionId: transaction.transactionId,
          refundReversal: true,
          supersededByNewerRefund: restoration.superseded,
          subscriptionReopened,
          storePurchaseFound: restoration.storePurchaseFound,
          restoredCreditTransactionIds: restoration.restoredCreditTransactionIds,
          totalRestoredMicrodollars: restoration.totalRestoredMicrodollars,
          restoredItemKinds: restoration.restoredItemKinds,
        },
      });
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
    await runAfterResponse(() => reportAppStoreCreditEventToBouncer({ notification, transaction }));
    return { processed: true };
  }

  if (transaction && REFUND_TYPES.has(notification.notificationType)) {
    await db.transaction(async tx => {
      let reversal: CreditReversalResult | null = null;
      try {
        reversal = await reverseAppStoreRefundCredits(tx, transaction, eventTimeMs);
      } catch (error) {
        captureException(error, {
          tags: { area: 'kilo-pass', operation: 'reverse-app-store-refund-credits' },
          extra: {
            notificationUuid: notification.notificationUUID,
            originalTransactionId: transaction.originalTransactionId,
            transactionId: transaction.transactionId,
            currency: transaction.currency ?? null,
          },
        });
      }
      // A newer reversal already restored this transaction, so this older refund changes nothing.
      const superseded = reversal?.superseded ?? false;
      if (!superseded) {
        await endStoreSubscription(tx, transaction);
      }
      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
        result: KiloPassAuditLogResult.Success,
        payload: {
          notificationUUID: notification.notificationUUID,
          providerSubscriptionId: transaction.originalTransactionId,
          providerTransactionId: transaction.transactionId,
          storePurchaseFound: reversal?.storePurchaseFound ?? false,
          creditTransactionIds: reversal?.creditTransactionIds ?? [],
          totalReversalMicrodollars: reversal?.totalReversalMicrodollars ?? 0,
          reversedItemKinds: reversal?.reversedItemKinds ?? [],
          supersededByNewerRefundReversal: superseded,
        },
      });
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
    await runAfterResponse(() => reportAppStoreCreditEventToBouncer({ notification, transaction }));
    return { processed: true };
  }

  if (transaction) {
    await runAfterResponse(() => reportAppStoreCreditEventToBouncer({ notification, transaction }));
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
