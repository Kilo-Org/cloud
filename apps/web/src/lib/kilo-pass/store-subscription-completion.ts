import {
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { toMicrodollars } from '@/lib/utils';
import { getMonthlyPriceUsd } from './bonus';
import { dayjs } from './dayjs';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  type KiloPassTier,
} from './enums';
import {
  appendKiloPassAuditLog,
  computeIssueMonth,
  createOrGetIssuanceHeader,
  issueBaseCreditsForIssuance,
} from './issuance';
import { isStripeSubscriptionEnded } from './stripe-subscription-status';

export type ValidatedStoreKiloPassPurchase = {
  paymentProvider: KiloPassPaymentProvider.AppStore | KiloPassPaymentProvider.GooglePlay;
  productId: string;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  providerSubscriptionId: string;
  purchaseToken: string | null;
  environment: string;
  purchasedAtIso: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  rawPayload: Record<string, unknown>;
};

export type CompleteStoreKiloPassPurchaseResult = {
  subscriptionId: string;
  tier: KiloPassTier;
  cadence: KiloPassCadence;
  alreadyProcessed: boolean;
};

function getIssuanceSource(
  paymentProvider: ValidatedStoreKiloPassPurchase['paymentProvider']
): KiloPassIssuanceSource {
  if (paymentProvider === KiloPassPaymentProvider.AppStore) {
    return KiloPassIssuanceSource.AppStoreTransaction;
  }
  return KiloPassIssuanceSource.GooglePlayTransaction;
}

function getNextYearlyIssueAt(params: {
  cadence: KiloPassCadence;
  purchasedAtIso: string;
}): string | null {
  if (params.cadence !== KiloPassCadence.Yearly) return null;
  return dayjs(params.purchasedAtIso).utc().add(1, 'month').toISOString();
}

function getProviderPaymentId(purchase: ValidatedStoreKiloPassPurchase): string {
  return `kilo-pass:${purchase.paymentProvider}:${purchase.providerTransactionId}`;
}

export async function completeStoreKiloPassPurchase(params: {
  user: User;
  purchase: ValidatedStoreKiloPassPurchase;
}): Promise<CompleteStoreKiloPassPurchaseResult> {
  const { user, purchase } = params;

  return db.transaction(async tx => {
    const existingPurchase = await tx.query.kilo_pass_store_purchases.findFirst({
      where: and(
        eq(kilo_pass_store_purchases.payment_provider, purchase.paymentProvider),
        eq(kilo_pass_store_purchases.provider_transaction_id, purchase.providerTransactionId)
      ),
    });

    if (existingPurchase) {
      if (existingPurchase.kilo_user_id !== user.id) {
        throw new Error('Store transaction already belongs to another user');
      }

      return {
        subscriptionId: existingPurchase.kilo_pass_subscription_id,
        tier: purchase.tier,
        cadence: purchase.cadence,
        alreadyProcessed: true,
      };
    }

    const activeSubscription = await tx.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.kilo_user_id, user.id),
        isNull(kilo_pass_subscriptions.ended_at)
      ),
    });

    if (
      activeSubscription &&
      !isStripeSubscriptionEnded(activeSubscription.status) &&
      activeSubscription.provider_subscription_id !== purchase.providerSubscriptionId
    ) {
      throw new Error('You already have an active Kilo Pass subscription');
    }

    const existingForProviderSubscription = await tx.query.kilo_pass_subscriptions.findFirst({
      where: and(
        eq(kilo_pass_subscriptions.payment_provider, purchase.paymentProvider),
        eq(kilo_pass_subscriptions.provider_subscription_id, purchase.providerSubscriptionId)
      ),
    });

    const nextYearlyIssueAt = getNextYearlyIssueAt({
      cadence: purchase.cadence,
      purchasedAtIso: purchase.purchasedAtIso,
    });

    const subscriptionRows = existingForProviderSubscription
      ? await tx
          .update(kilo_pass_subscriptions)
          .set({
            kilo_user_id: user.id,
            tier: purchase.tier,
            cadence: purchase.cadence,
            status: 'active',
            cancel_at_period_end: false,
            ended_at: null,
            next_yearly_issue_at: nextYearlyIssueAt,
          })
          .where(eq(kilo_pass_subscriptions.id, existingForProviderSubscription.id))
          .returning({ id: kilo_pass_subscriptions.id })
      : await tx
          .insert(kilo_pass_subscriptions)
          .values({
            kilo_user_id: user.id,
            payment_provider: purchase.paymentProvider,
            provider_subscription_id: purchase.providerSubscriptionId,
            stripe_subscription_id: null,
            tier: purchase.tier,
            cadence: purchase.cadence,
            status: 'active',
            cancel_at_period_end: false,
            started_at: purchase.purchasedAtIso,
            ended_at: null,
            current_streak_months: 1,
            next_yearly_issue_at: nextYearlyIssueAt,
          })
          .returning({ id: kilo_pass_subscriptions.id });

    const subscriptionId = subscriptionRows[0]?.id;
    if (!subscriptionId) {
      throw new Error('Failed to persist store Kilo Pass subscription');
    }

    await tx.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscriptionId,
      kilo_user_id: user.id,
      payment_provider: purchase.paymentProvider,
      product_id: purchase.productId,
      provider_subscription_id: purchase.providerSubscriptionId,
      provider_transaction_id: purchase.providerTransactionId,
      provider_original_transaction_id: purchase.providerOriginalTransactionId,
      purchase_token: purchase.purchaseToken,
      environment: purchase.environment,
      purchased_at: purchase.purchasedAtIso,
      raw_payload_json: purchase.rawPayload,
    });

    const issueMonth = computeIssueMonth(dayjs(purchase.purchasedAtIso));
    const issuanceHeader = await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: getIssuanceSource(purchase.paymentProvider),
    });

    const baseAmountUsd = getMonthlyPriceUsd(purchase.tier);
    const baseCreditsResult = await issueBaseCreditsForIssuance(tx, {
      issuanceId: issuanceHeader.issuanceId,
      subscriptionId,
      kiloUserId: user.id,
      amountUsd: baseAmountUsd,
      providerPaymentId: getProviderPaymentId(purchase),
      description: `Kilo Pass base credits (${purchase.tier}, ${purchase.cadence})`,
    });

    if (baseCreditsResult.wasIssued) {
      await tx
        .update(kilocode_users)
        .set({
          kilo_pass_threshold: sql`${kilocode_users.microdollars_used} + ${toMicrodollars(
            baseAmountUsd
          )}`,
        })
        .where(eq(kilocode_users.id, user.id));
    }

    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.StorePurchaseCompleted,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: user.id,
      kiloPassSubscriptionId: subscriptionId,
      relatedMonthlyIssuanceId: issuanceHeader.issuanceId,
      payload: {
        paymentProvider: purchase.paymentProvider,
        productId: purchase.productId,
        providerSubscriptionId: purchase.providerSubscriptionId,
        providerTransactionId: purchase.providerTransactionId,
        issueMonth,
        issuanceHeaderWasCreated: issuanceHeader.wasCreated,
        baseCreditsIssued: baseCreditsResult.wasIssued,
      },
    });

    return {
      subscriptionId,
      tier: purchase.tier,
      cadence: purchase.cadence,
      alreadyProcessed: false,
    };
  });
}
