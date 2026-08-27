import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

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
  decodeGooglePlaySubscriptionPurchase,
  mapGooglePlayKiloPassPurchase,
} from './google-play-verifier';
import { GOOGLE_PLAY_PACKAGE_NAME, getGooglePlaySubscriptionPurchase } from './google-play-sdk';
import {
  completeStoreKiloPassPurchase,
  isStorePurchaseMismatchError,
  type CompleteStoreKiloPassPurchaseResult,
} from './store-subscription-completion';
import { runAfterResponse, trackKiloPassPurchaseCompleted } from '@/lib/kilo-pass/posthog-tracking';
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import { dayjs } from './dayjs';

type DbOrTx = DrizzleTransaction | typeof db;

export type GooglePlayPubSubMessage = {
  data: string;
  messageId?: string;
};

type GooglePlayDeveloperNotification = {
  packageName?: string;
  eventTimeMillis?: string | number;
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

// Google Play Real-time Developer Notification subscription types:
// https://developer.android.com/google/play/billing/subscriptions#notification-types
const GOOGLE_PLAY_NOTIFICATION_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
} as const;

const PURCHASE_TYPES = new Set<number>([
  GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED,
  GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED,
  GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED,
  GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED,
]);

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
  notificationType: number;
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
  notificationType: number;
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
  notificationType: number;
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

async function markGooglePlayStoreEventProcessed(eventId: string): Promise<void> {
  await db
    .update(kilo_pass_store_events)
    .set({ processed_at: new Date().toISOString() })
    .where(
      and(
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_events.event_id, eventId)
      )
    );
}

async function markGooglePlaySubscriptionCancelingAtPeriodEnd(
  purchaseToken: string
): Promise<void> {
  await db
    .update(kilo_pass_subscriptions)
    .set({
      cancel_at_period_end: true,
    })
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, purchaseToken)
      )
    );
}

async function markGooglePlaySubscriptionEnded(
  dbOrTx: DbOrTx,
  purchaseToken: string
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
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, purchaseToken)
      )
    );
}

async function getUserForGooglePlayRenewal(params: {
  providerSubscriptionId: string;
  appAccountToken: string | null;
}): Promise<User | null> {
  const row = await db
    .select({ user: kilocode_users })
    .from(kilo_pass_subscriptions)
    .innerJoin(kilocode_users, eq(kilo_pass_subscriptions.kilo_user_id, kilocode_users.id))
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_subscriptions.provider_subscription_id, params.providerSubscriptionId)
      )
    )
    .limit(1);

  if (row[0]?.user) {
    if (row[0].user.app_store_account_token !== params.appAccountToken) {
      throw new Error('Google Play renewal account token does not match subscription owner');
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

function getGooglePlayRefundReversalDescription(kind: KiloPassIssuanceItemKind): string {
  if (kind === KiloPassIssuanceItemKind.Base) {
    return 'Google Play Kilo Pass refund clawback';
  }
  if (kind === KiloPassIssuanceItemKind.Bonus) {
    return 'Google Play Kilo Pass bonus refund clawback';
  }
  return 'Google Play Kilo Pass promo refund clawback';
}

function getGooglePlayProviderPaymentId(providerTransactionId: string): string {
  return `kilo-pass:${KiloPassPaymentProvider.GooglePlay}:${providerTransactionId}`;
}

function getGooglePlayUpgradeBaseCreditCategory(providerTransactionId: string): string {
  return `kilo-pass-upgrade-base:${KiloPassPaymentProvider.GooglePlay}:${providerTransactionId}`;
}

async function reverseGooglePlayRefundCredits(
  tx: DrizzleTransaction,
  purchaseToken: string,
  latestOrderId: string
): Promise<CreditReversalResult> {
  let storePurchase = await tx.query.kilo_pass_store_purchases.findFirst({
    where: and(
      eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.GooglePlay),
      eq(kilo_pass_store_purchases.provider_subscription_id, purchaseToken),
      eq(kilo_pass_store_purchases.provider_transaction_id, latestOrderId)
    ),
  });

  if (!storePurchase) {
    storePurchase = await tx.query.kilo_pass_store_purchases.findFirst({
      where: and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_purchases.provider_subscription_id, purchaseToken)
      ),
      orderBy: desc(kilo_pass_store_purchases.purchased_at),
    });
  }

  if (!storePurchase) {
    return {
      storePurchaseFound: false,
      creditTransactionIds: [],
      totalReversalMicrodollars: 0,
      reversedItemKinds: [],
    };
  }

  const providerTransactionId = storePurchase.provider_transaction_id;

  const userRows = await tx
    .select({ microdollarsUsed: kilocode_users.microdollars_used })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, storePurchase.kilo_user_id))
    .for('update')
    .limit(1);
  const user = userRows[0];
  if (!user) {
    throw new Error('Google Play refund cannot find the subscribed user');
  }

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
            getGooglePlayProviderPaymentId(providerTransactionId)
          ),
          eq(
            credit_transactions.credit_category,
            getGooglePlayUpgradeBaseCreditCategory(providerTransactionId)
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
              getGooglePlayProviderPaymentId(providerTransactionId)
            ),
            eq(
              credit_transactions.credit_category,
              getGooglePlayUpgradeBaseCreditCategory(providerTransactionId)
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
    // Reverse what Kilo granted, never the Play store price. Google returns the
    // full charge to the customer and reverses its own commission, so clawing
    // back the store price would leave a customer who spent nothing at minus the
    // store margin.
    const reversalAmountMicrodollars = item.amountMicrodollars;

    if (reversalAmountMicrodollars <= 0) {
      continue;
    }

    const reversal = await insertCreditReversal(tx, {
      kiloUserId: storePurchase.kilo_user_id,
      amountMicrodollars: reversalAmountMicrodollars,
      isFree: item.isFree,
      description: getGooglePlayRefundReversalDescription(item.kind),
      creditCategory: `kilo-pass-store-refund:${KiloPassPaymentProvider.GooglePlay}:${providerTransactionId}:${item.kind}:${item.itemId}`,
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
    creditTransactionIds,
    totalReversalMicrodollars,
    reversedItemKinds,
  };
}

type TerminalStoreEvent = {
  eventId: string;
  notificationType: string | null;
  terminalTimestampMs: number | null;
};

async function findProcessedTerminalStoreEventForGooglePlayPurchase(params: {
  purchaseToken: string;
  providerTransactionId: string;
  purchasedAtMs: number;
}): Promise<TerminalStoreEvent | null> {
  const terminalNotificationTypeFilter = sql`(${kilo_pass_store_events.payload_json}->>'notificationType') = '12'`;
  const terminalTimestampMs = sql<
    number | null
  >`(${kilo_pass_store_events.payload_json}->>'eventTimeMillis')::double precision`;

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
        eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
        sql`${kilo_pass_store_events.processed_at} IS NOT NULL`,
        terminalNotificationTypeFilter,
        or(
          eq(kilo_pass_store_events.provider_transaction_id, params.providerTransactionId),
          and(
            eq(kilo_pass_store_events.provider_subscription_id, params.purchaseToken),
            sql`${terminalTimestampMs} >= ${params.purchasedAtMs}`
          )
        )
      )
    )
    .limit(1);

  return terminalEvents[0] ?? null;
}

export async function processGooglePlayKiloPassNotification(params: {
  pubsubMessage: GooglePlayPubSubMessage;
}): Promise<GooglePlayKiloPassNotificationProcessingResult> {
  const { data, messageId } = params.pubsubMessage;
  const developerNotification = decodeGooglePlayDeveloperNotification(data);

  if (developerNotification.packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
    throw new Error('Google Play notification package mismatch');
  }

  const subscriptionNotification = developerNotification.subscriptionNotification;
  if (!subscriptionNotification) {
    // One-time product and voided-purchase notifications carry no subscription
    // lifecycle event that this handler manages.
    return { processed: true };
  }

  const notificationType = subscriptionNotification.notificationType;
  const purchaseToken = subscriptionNotification.purchaseToken;

  if (notificationType == null || purchaseToken == null) {
    throw new Error('Google Play notification missing subscription identifiers');
  }

  const eventTimeMillis = developerNotification.eventTimeMillis ?? null;
  const eventId = computeGooglePlayEventId({
    messageId,
    purchaseToken,
    notificationType,
    eventTimeMillis,
  });

  const apiData = await getGooglePlaySubscriptionPurchase(purchaseToken);
  const decoded = decodeGooglePlaySubscriptionPurchase(apiData, purchaseToken);

  const claim = await claimGooglePlayStoreEventForProcessing({
    eventId,
    notificationType,
    packageName: developerNotification.packageName,
    eventTimeMillis,
    purchaseToken,
    latestOrderId: decoded.latestOrderId,
    appAccountToken: decoded.obfuscatedExternalAccountId ?? null,
    productId: decoded.productId || 'unknown',
    environment: decoded.environment,
  });
  if (claim === 'already_processed') {
    return { processed: true, status: 'already_processed' };
  }
  if (claim === 'in_flight') {
    return { processed: false, status: 'in_flight' };
  }

  const isPurchaseType = PURCHASE_TYPES.has(notificationType);
  const isExpired = decoded.expiryTimeMs <= Date.now();

  if (isPurchaseType) {
    if (isExpired) {
      await markGooglePlayStoreEventProcessed(eventId);
      return { processed: true };
    }

    const purchase = mapGooglePlayKiloPassPurchase(decoded);

    const terminalEvent = await findProcessedTerminalStoreEventForGooglePlayPurchase({
      purchaseToken,
      providerTransactionId: purchase.providerTransactionId,
      purchasedAtMs: decoded.startTimeMs,
    });
    if (terminalEvent) {
      await db.transaction(async tx => {
        await appendKiloPassAuditLog(tx, {
          action: KiloPassAuditLogAction.StoreNotificationReceived,
          result: KiloPassAuditLogResult.Success,
          payload: {
            messageId: messageId ?? null,
            notificationType,
            providerSubscriptionId: purchaseToken,
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
              eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
              eq(kilo_pass_store_events.event_id, eventId)
            )
          );
      });
      return { processed: true };
    }

    const user = await getUserForGooglePlayRenewal({
      providerSubscriptionId: purchase.providerSubscriptionId,
      appAccountToken: purchase.appAccountToken,
    });
    if (!user) {
      if (notificationType !== GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED) {
        throw new Error(
          'Google Play renewal notification cannot create a subscription without a user'
        );
      }
      await markGooglePlayStoreEventProcessed(eventId);
      return { processed: true };
    }

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
                eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.GooglePlay),
                eq(kilo_pass_store_events.event_id, eventId)
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
          messageId: messageId ?? null,
          providerSubscriptionId: purchase.providerSubscriptionId,
        },
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
    if (purchaseMismatch) {
      return { processed: true };
    }
    // Post-commit only — never capture inside the transaction.
    const trackedResult = completionResult as CompleteStoreKiloPassPurchaseResult | null;
    if (trackedResult && !trackedResult.alreadyProcessed) {
      await runAfterResponse(async () => {
        trackKiloPassPurchaseCompleted({
          channel: 'google_play',
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
    return { processed: true };
  }

  if (notificationType === GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED) {
    await markGooglePlaySubscriptionCancelingAtPeriodEnd(purchaseToken);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionCanceled,
      result: KiloPassAuditLogResult.Success,
      payload: {
        messageId: messageId ?? null,
        providerSubscriptionId: purchaseToken,
      },
    });
    await markGooglePlayStoreEventProcessed(eventId);
    return { processed: true };
  }

  if (notificationType === GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED) {
    await markGooglePlaySubscriptionEnded(db, purchaseToken);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionExpired,
      result: KiloPassAuditLogResult.Success,
      payload: {
        messageId: messageId ?? null,
        providerSubscriptionId: purchaseToken,
      },
    });
    await markGooglePlayStoreEventProcessed(eventId);
    return { processed: true };
  }

  if (notificationType === GOOGLE_PLAY_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED) {
    await db.transaction(async tx => {
      let reversal: CreditReversalResult | null = null;
      try {
        reversal = await reverseGooglePlayRefundCredits(tx, purchaseToken, decoded.latestOrderId);
      } catch (error) {
        captureException(error, {
          tags: { area: 'kilo-pass', operation: 'reverse-google-play-refund-credits' },
          extra: {
            purchaseToken,
            latestOrderId: decoded.latestOrderId,
          },
        });
      }
      await markGooglePlaySubscriptionEnded(tx, purchaseToken);
      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
        result: KiloPassAuditLogResult.Success,
        payload: {
          messageId: messageId ?? null,
          providerSubscriptionId: purchaseToken,
          providerTransactionId: decoded.latestOrderId,
          storePurchaseFound: reversal?.storePurchaseFound ?? false,
          creditTransactionIds: reversal?.creditTransactionIds ?? [],
          totalReversalMicrodollars: reversal?.totalReversalMicrodollars ?? 0,
          reversedItemKinds: reversal?.reversedItemKinds ?? [],
        },
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

  // Unknown subscription notification types (deferred, paused, price change, etc.):
  // claim the event and mark it processed without acting.
  await markGooglePlayStoreEventProcessed(eventId);
  return { processed: true };
}
