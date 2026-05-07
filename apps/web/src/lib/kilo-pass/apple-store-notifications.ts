import { type ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';

import {
  kilo_pass_store_events,
  kilo_pass_subscriptions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { KiloPassAuditLogAction, KiloPassAuditLogResult, KiloPassPaymentProvider } from './enums';
import { appendKiloPassAuditLog } from './issuance';
import {
  createAppleStoreSignedDataVerifier,
  decodeAppleStoreTransactionJws,
  mapAppleKiloPassTransaction,
  type AppleStoreDecodedTransaction,
  type AppleStoreEnvironment,
} from './apple-store-verifier';
import { completeStoreKiloPassPurchase } from './store-subscription-completion';

export type AppleStoreDecodedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  environment: AppleStoreEnvironment;
  signedTransactionInfo?: string;
};

type DecodeNotification = (signedPayload: string) => Promise<AppleStoreDecodedNotification>;
type DecodeTransaction = (signedTransactionJws: string) => Promise<AppleStoreDecodedTransaction>;

const RENEWAL_TYPES = new Set(['DID_RENEW', 'SUBSCRIBED']);
const EXPIRED_TYPES = new Set(['EXPIRED', 'DID_FAIL_TO_RENEW']);
const REFUND_TYPES = new Set(['REFUND', 'REVOKE', 'CONSUMPTION_REQUEST']);

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
    .where(eq(kilo_pass_subscriptions.provider_subscription_id, transaction.originalTransactionId));
}

async function getUserForStoreRenewal(params: {
  providerSubscriptionId: string;
  appAccountToken: string | null;
  fallbackUser?: User;
}): Promise<User | null> {
  if (params.fallbackUser) return params.fallbackUser;

  const row = await db
    .select({ user: kilocode_users })
    .from(kilo_pass_subscriptions)
    .innerJoin(kilocode_users, eq(kilo_pass_subscriptions.kilo_user_id, kilocode_users.id))
    .where(eq(kilo_pass_subscriptions.provider_subscription_id, params.providerSubscriptionId))
    .limit(1);

  if (row[0]?.user) return row[0].user;

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
}): Record<string, unknown> {
  return {
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
          environment: params.purchase.environment,
          tier: params.purchase.tier,
          cadence: params.purchase.cadence,
        }
      : null,
  };
}

export async function processAppStoreKiloPassNotification(params: {
  signedPayload: string;
  userForRenewal?: User;
  decodeNotification?: DecodeNotification;
  decodeTransaction?: DecodeTransaction;
}): Promise<{ processed: boolean }> {
  const decodeNotification = params.decodeNotification ?? decodeAppleStoreNotificationJws;
  const decodeTransaction = params.decodeTransaction ?? decodeAppleStoreTransactionJws;
  const notification = await decodeNotification(params.signedPayload);
  const transaction = notification.signedTransactionInfo
    ? await decodeTransaction(notification.signedTransactionInfo)
    : null;
  const purchase = transaction ? mapAppleKiloPassTransaction(transaction) : null;

  const insertResult = await db
    .insert(kilo_pass_store_events)
    .values({
      payment_provider: KiloPassPaymentProvider.AppStore,
      event_id: notification.notificationUUID,
      provider_subscription_id: purchase?.providerSubscriptionId ?? null,
      provider_transaction_id: purchase?.providerTransactionId ?? null,
      app_account_token: purchase?.appAccountToken ?? null,
      product_id: purchase?.productId ?? 'unknown',
      environment: notification.environment,
      payload_json: getStoreEventPayload({ notification, purchase }),
    })
    .onConflictDoNothing();

  if ((insertResult.rowCount ?? 0) === 0) {
    const existingEvents = await db
      .select({ processedAt: kilo_pass_store_events.processed_at })
      .from(kilo_pass_store_events)
      .where(
        and(
          eq(kilo_pass_store_events.payment_provider, KiloPassPaymentProvider.AppStore),
          eq(kilo_pass_store_events.event_id, notification.notificationUUID)
        )
      )
      .limit(1);

    if (existingEvents[0]?.processedAt) {
      return { processed: false };
    }
  }

  if (purchase && RENEWAL_TYPES.has(notification.notificationType)) {
    const user = await getUserForStoreRenewal({
      providerSubscriptionId: purchase.providerSubscriptionId,
      appAccountToken: purchase.appAccountToken,
      fallbackUser: params.userForRenewal,
    });
    if (!user) {
      if (notification.notificationType !== 'SUBSCRIBED') {
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

  if (transaction && REFUND_TYPES.has(notification.notificationType)) {
    await markStoreSubscriptionEnded(transaction);
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.StoreSubscriptionRefunded,
      result: KiloPassAuditLogResult.Success,
      payload: {
        notificationUUID: notification.notificationUUID,
        providerSubscriptionId: transaction.originalTransactionId,
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
