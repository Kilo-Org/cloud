import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { toMicrodollars } from '@/lib/utils';
import { getMonthlyPriceUsd } from './bonus';
import { dayjs } from './dayjs';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceItemKind,
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
import { redactStoreAccountLinkedJson } from './store-payload-redaction';
import {
  computeMonthlyKiloPassStreak,
  updateKiloPassThresholdAfterBaseCredits,
} from './subscription-accounting';
import { isStripeSubscriptionEnded } from './stripe-subscription-status';

export type ValidatedStoreKiloPassPurchase = {
  paymentProvider: KiloPassPaymentProvider.AppStore | KiloPassPaymentProvider.GooglePlay;
  productId: string;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  providerSubscriptionId: string;
  appAccountToken: string | null;
  purchaseToken: string | null;
  environment: string;
  purchasedAtIso: string;
  expiresAtIso: string | null;
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

function findStorePurchaseByProviderTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  purchase: ValidatedStoreKiloPassPurchase
) {
  return tx.query.kilo_pass_store_purchases.findFirst({
    where: and(
      eq(kilo_pass_store_purchases.payment_provider, purchase.paymentProvider),
      eq(kilo_pass_store_purchases.provider_transaction_id, purchase.providerTransactionId)
    ),
  });
}

async function lockUserForStoreCompletion(tx: DrizzleTransaction, userId: string): Promise<void> {
  const rows = await tx
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .for('update')
    .limit(1);

  if (!rows[0]) {
    throw new Error('Failed to lock user for store Kilo Pass completion');
  }
}

function findLatestStorePurchaseForSubscription(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  purchase: ValidatedStoreKiloPassPurchase
) {
  return tx.query.kilo_pass_store_purchases.findFirst({
    where: and(
      eq(kilo_pass_store_purchases.payment_provider, purchase.paymentProvider),
      eq(kilo_pass_store_purchases.provider_subscription_id, purchase.providerSubscriptionId)
    ),
    orderBy: desc(kilo_pass_store_purchases.purchased_at),
  });
}

function isStorePurchaseWithinPreviousPeriod(params: {
  previousPurchasedAtIso: string;
  previousExpiresAtIso: string;
  purchasedAtIso: string;
}): boolean {
  const previousPurchasedAt = dayjs(params.previousPurchasedAtIso).valueOf();
  const previousExpiresAt = dayjs(params.previousExpiresAtIso).valueOf();
  const purchasedAt = dayjs(params.purchasedAtIso).valueOf();

  return purchasedAt >= previousPurchasedAt && purchasedAt < previousExpiresAt;
}

async function findStoreSubscriptionByProviderSubscriptionForUpdate(
  tx: DrizzleTransaction,
  purchase: ValidatedStoreKiloPassPurchase
) {
  const rows = await tx
    .select({
      id: kilo_pass_subscriptions.id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
    })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.payment_provider, purchase.paymentProvider),
        eq(kilo_pass_subscriptions.provider_subscription_id, purchase.providerSubscriptionId)
      )
    )
    .for('update')
    .limit(1);

  return rows[0] ?? null;
}

function computeProratedRefundMicrodollars(params: {
  oldTier: KiloPassTier;
  oldPurchasedAtIso: string;
  oldExpiresAtIso: string;
  upgradePurchasedAtIso: string;
}): number {
  const oldPurchasedAt = dayjs(params.oldPurchasedAtIso).valueOf();
  const oldExpiresAt = dayjs(params.oldExpiresAtIso).valueOf();
  const upgradePurchasedAt = dayjs(params.upgradePurchasedAtIso).valueOf();
  const periodMs = oldExpiresAt - oldPurchasedAt;
  if (periodMs <= 0) return 0;

  const remainingMs = Math.max(0, Math.min(oldExpiresAt - upgradePurchasedAt, periodMs));
  const oldTierMicrodollars = toMicrodollars(getMonthlyPriceUsd(params.oldTier));
  return Math.round(oldTierMicrodollars * (remainingMs / periodMs));
}

async function insertCreditTransactionAdjustment(
  tx: DrizzleTransaction,
  params: {
    kiloUserId: string;
    amountMicrodollars: number;
    description: string;
    creditCategory: string;
    originalBaselineMicrodollarsUsed: number;
    isFree?: boolean;
  }
): Promise<{ wasInserted: boolean; creditTransactionId: string | null }> {
  const creditTransactionId = crypto.randomUUID();
  const insertResult = await tx
    .insert(credit_transactions)
    .values({
      id: creditTransactionId,
      kilo_user_id: params.kiloUserId,
      amount_microdollars: params.amountMicrodollars,
      is_free: params.isFree ?? false,
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
      total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${params.amountMicrodollars}`,
    })
    .where(eq(kilocode_users.id, params.kiloUserId));

  return { wasInserted: true, creditTransactionId };
}

function getUpgradeBonusReversalDescription(kind: KiloPassIssuanceItemKind): string {
  if (kind === KiloPassIssuanceItemKind.Bonus) {
    return 'Kilo Pass upgrade bonus clawback';
  }
  return 'Kilo Pass upgrade promo clawback';
}

async function resetIssuanceItemsForStoreUpgrade(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    subscriptionId: string;
    user: User;
    purchase: ValidatedStoreKiloPassPurchase;
    upgradedBaseCreditTransactionId: string;
    upgradedBaseAmountUsd: number;
    originalBaselineMicrodollarsUsed: number;
  }
): Promise<void> {
  const bonusItems = await tx
    .select({
      itemId: kilo_pass_issuance_items.id,
      kind: kilo_pass_issuance_items.kind,
      amountMicrodollars: credit_transactions.amount_microdollars,
    })
    .from(kilo_pass_issuance_items)
    .innerJoin(
      credit_transactions,
      eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
    )
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, params.issuanceId),
        inArray(kilo_pass_issuance_items.kind, [
          KiloPassIssuanceItemKind.Bonus,
          KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        ])
      )
    );

  const reversedBonusCreditTransactionIds: string[] = [];
  for (const item of bonusItems) {
    if (item.amountMicrodollars <= 0) {
      continue;
    }

    const reversal = await insertCreditTransactionAdjustment(tx, {
      kiloUserId: params.user.id,
      amountMicrodollars: -item.amountMicrodollars,
      description: getUpgradeBonusReversalDescription(item.kind),
      creditCategory: `kilo-pass-upgrade-bonus-reversal:${params.purchase.paymentProvider}:${params.purchase.providerTransactionId}:${item.kind}:${item.itemId}`,
      originalBaselineMicrodollarsUsed: params.originalBaselineMicrodollarsUsed,
      isFree: true,
    });
    if (reversal.creditTransactionId) {
      reversedBonusCreditTransactionIds.push(reversal.creditTransactionId);
    }
  }

  if (bonusItems.length > 0) {
    await tx.delete(kilo_pass_issuance_items).where(
      inArray(
        kilo_pass_issuance_items.id,
        bonusItems.map(item => item.itemId)
      )
    );
  }

  const baseUpdate = await tx
    .update(kilo_pass_issuance_items)
    .set({
      credit_transaction_id: params.upgradedBaseCreditTransactionId,
      amount_usd: params.upgradedBaseAmountUsd,
      bonus_percent_applied: null,
    })
    .where(
      and(
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, params.issuanceId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    );

  if ((baseUpdate.rowCount ?? 0) !== 1) {
    throw new Error('App Store upgrade could not update the current base issuance item');
  }

  await appendKiloPassAuditLog(tx, {
    action: KiloPassAuditLogAction.BaseCreditsIssued,
    result: KiloPassAuditLogResult.Success,
    kiloUserId: params.user.id,
    kiloPassSubscriptionId: params.subscriptionId,
    relatedCreditTransactionId: params.upgradedBaseCreditTransactionId,
    relatedMonthlyIssuanceId: params.issuanceId,
    payload: {
      kind: 'store_upgrade_current_issuance_rewritten',
      providerSubscriptionId: params.purchase.providerSubscriptionId,
      providerTransactionId: params.purchase.providerTransactionId,
      upgradedBaseAmountUsd: params.upgradedBaseAmountUsd,
      removedIssuanceItemIds: bonusItems.map(item => item.itemId),
      reversedBonusCreditTransactionIds,
    },
  });
}

async function applyStoreUpgradeCreditAdjustments(
  tx: DrizzleTransaction,
  params: {
    issuanceId: string;
    subscriptionId: string;
    user: User;
    purchase: ValidatedStoreKiloPassPurchase;
    oldTier: KiloPassTier;
    oldPurchasedAtIso: string;
    oldExpiresAtIso: string;
  }
): Promise<void> {
  const freshUserRows = await tx
    .select({ microdollarsUsed: kilocode_users.microdollars_used })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, params.user.id))
    .for('update')
    .limit(1);
  const freshUser = freshUserRows[0];
  if (!freshUser) {
    throw new Error('Failed to lock user for App Store upgrade credit adjustment');
  }

  const refundMicrodollars = computeProratedRefundMicrodollars({
    oldTier: params.oldTier,
    oldPurchasedAtIso: params.oldPurchasedAtIso,
    oldExpiresAtIso: params.oldExpiresAtIso,
    upgradePurchasedAtIso: params.purchase.purchasedAtIso,
  });

  if (refundMicrodollars > 0) {
    const refundResult = await insertCreditTransactionAdjustment(tx, {
      kiloUserId: params.user.id,
      amountMicrodollars: -refundMicrodollars,
      description: `Kilo Pass upgrade refund clawback (${params.oldTier})`,
      creditCategory: `kilo-pass-upgrade-refund:${params.purchase.paymentProvider}:${params.purchase.providerTransactionId}`,
      originalBaselineMicrodollarsUsed: freshUser.microdollarsUsed,
    });
    await appendKiloPassAuditLog(tx, {
      action: KiloPassAuditLogAction.BaseCreditsIssued,
      result: refundResult.wasInserted
        ? KiloPassAuditLogResult.Success
        : KiloPassAuditLogResult.SkippedIdempotent,
      kiloUserId: params.user.id,
      kiloPassSubscriptionId: params.subscriptionId,
      relatedCreditTransactionId: refundResult.creditTransactionId,
      payload: {
        kind: 'store_upgrade_refund_clawback',
        oldTier: params.oldTier,
        providerSubscriptionId: params.purchase.providerSubscriptionId,
        providerTransactionId: params.purchase.providerTransactionId,
        amountMicrodollars: -refundMicrodollars,
      },
    });
  }

  const newTierAmountUsd = getMonthlyPriceUsd(params.purchase.tier);
  const newTierMicrodollars = toMicrodollars(newTierAmountUsd);
  const issueResult = await insertCreditTransactionAdjustment(tx, {
    kiloUserId: params.user.id,
    amountMicrodollars: newTierMicrodollars,
    description: `Kilo Pass upgrade base credits (${params.purchase.tier}, ${params.purchase.cadence})`,
    creditCategory: `kilo-pass-upgrade-base:${params.purchase.paymentProvider}:${params.purchase.providerTransactionId}`,
    originalBaselineMicrodollarsUsed: freshUser.microdollarsUsed,
  });

  if (issueResult.wasInserted) {
    await updateKiloPassThresholdAfterBaseCredits(tx, {
      kiloUserId: params.user.id,
      baseAmountUsd: newTierAmountUsd,
    });
  }

  await appendKiloPassAuditLog(tx, {
    action: KiloPassAuditLogAction.BaseCreditsIssued,
    result: issueResult.wasInserted
      ? KiloPassAuditLogResult.Success
      : KiloPassAuditLogResult.SkippedIdempotent,
    kiloUserId: params.user.id,
    kiloPassSubscriptionId: params.subscriptionId,
    relatedCreditTransactionId: issueResult.creditTransactionId,
    payload: {
      kind: 'store_upgrade_base',
      tier: params.purchase.tier,
      cadence: params.purchase.cadence,
      providerSubscriptionId: params.purchase.providerSubscriptionId,
      providerTransactionId: params.purchase.providerTransactionId,
      amountUsd: newTierAmountUsd,
    },
  });

  if (!issueResult.creditTransactionId) {
    throw new Error('App Store upgrade base credit transaction was not persisted');
  }

  await resetIssuanceItemsForStoreUpgrade(tx, {
    issuanceId: params.issuanceId,
    subscriptionId: params.subscriptionId,
    user: params.user,
    purchase: params.purchase,
    upgradedBaseCreditTransactionId: issueResult.creditTransactionId,
    upgradedBaseAmountUsd: newTierAmountUsd,
    originalBaselineMicrodollarsUsed: freshUser.microdollarsUsed,
  });
}

export async function completeStoreKiloPassPurchase(params: {
  dbOrTx?: DrizzleTransaction;
  user: User;
  purchase: ValidatedStoreKiloPassPurchase;
}): Promise<CompleteStoreKiloPassPurchaseResult> {
  const { user, purchase } = params;

  const run = async (tx: DrizzleTransaction): Promise<CompleteStoreKiloPassPurchaseResult> => {
    await lockUserForStoreCompletion(tx, user.id);

    const existingPurchase = await findStorePurchaseByProviderTransaction(tx, purchase);

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

    const existingProviderSubscription = await findStoreSubscriptionByProviderSubscriptionForUpdate(
      tx,
      purchase
    );

    if (existingProviderSubscription && existingProviderSubscription.kiloUserId !== user.id) {
      throw new Error('Store subscription already belongs to another user');
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

    const previousStorePurchase =
      activeSubscription?.provider_subscription_id === purchase.providerSubscriptionId
        ? await findLatestStorePurchaseForSubscription(tx, purchase)
        : null;
    const isAppStoreSamePeriodUpgrade =
      purchase.paymentProvider === KiloPassPaymentProvider.AppStore &&
      activeSubscription?.provider_subscription_id === purchase.providerSubscriptionId &&
      getMonthlyPriceUsd(purchase.tier) > getMonthlyPriceUsd(activeSubscription.tier) &&
      previousStorePurchase?.expires_at != null &&
      isStorePurchaseWithinPreviousPeriod({
        previousPurchasedAtIso: previousStorePurchase.purchased_at,
        previousExpiresAtIso: previousStorePurchase.expires_at,
        purchasedAtIso: purchase.purchasedAtIso,
      });

    const nextYearlyIssueAt = getNextYearlyIssueAt({
      cadence: purchase.cadence,
      purchasedAtIso: purchase.purchasedAtIso,
    });

    const subscriptionRows = await tx
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
      .onConflictDoUpdate({
        target: [
          kilo_pass_subscriptions.payment_provider,
          kilo_pass_subscriptions.provider_subscription_id,
        ],
        targetWhere: sql`${kilo_pass_subscriptions.provider_subscription_id} IS NOT NULL`,
        set: {
          tier: purchase.tier,
          cadence: purchase.cadence,
          status: 'active',
          cancel_at_period_end: false,
          ended_at: null,
          next_yearly_issue_at: nextYearlyIssueAt,
        },
        setWhere: eq(kilo_pass_subscriptions.kilo_user_id, user.id),
      })
      .returning({ id: kilo_pass_subscriptions.id });

    const subscriptionId = subscriptionRows[0]?.id;
    if (!subscriptionId) {
      throw new Error('Failed to persist store Kilo Pass subscription');
    }

    const purchaseRows = await tx
      .insert(kilo_pass_store_purchases)
      .values({
        kilo_pass_subscription_id: subscriptionId,
        kilo_user_id: user.id,
        payment_provider: purchase.paymentProvider,
        product_id: purchase.productId,
        provider_subscription_id: purchase.providerSubscriptionId,
        provider_transaction_id: purchase.providerTransactionId,
        provider_original_transaction_id: purchase.providerOriginalTransactionId,
        app_account_token: purchase.appAccountToken,
        purchase_token:
          purchase.paymentProvider === KiloPassPaymentProvider.AppStore
            ? null
            : purchase.purchaseToken,
        environment: purchase.environment,
        purchased_at: purchase.purchasedAtIso,
        expires_at: purchase.expiresAtIso,
        raw_payload_json: redactStoreAccountLinkedJson(purchase.rawPayload),
      })
      .onConflictDoNothing({
        target: [
          kilo_pass_store_purchases.payment_provider,
          kilo_pass_store_purchases.provider_transaction_id,
        ],
      })
      .returning({
        id: kilo_pass_store_purchases.id,
      });

    if (!purchaseRows[0]) {
      const replayedPurchase = await findStorePurchaseByProviderTransaction(tx, purchase);

      if (!replayedPurchase) {
        throw new Error('Failed to persist store Kilo Pass purchase');
      }

      if (replayedPurchase.kilo_user_id !== user.id) {
        throw new Error('Store transaction already belongs to another user');
      }

      return {
        subscriptionId: replayedPurchase.kilo_pass_subscription_id,
        tier: purchase.tier,
        cadence: purchase.cadence,
        alreadyProcessed: true,
      };
    }

    const issueMonth = computeIssueMonth(
      dayjs(
        isAppStoreSamePeriodUpgrade && previousStorePurchase
          ? previousStorePurchase.purchased_at
          : purchase.purchasedAtIso
      )
    );
    const issuanceHeader = await createOrGetIssuanceHeader(tx, {
      subscriptionId,
      issueMonth,
      source: getIssuanceSource(purchase.paymentProvider),
    });

    const baseAmountUsd = getMonthlyPriceUsd(purchase.tier);
    const baseCreditsResult = isAppStoreSamePeriodUpgrade
      ? {
          wasIssued: false,
          amountUsd: baseAmountUsd,
        }
      : await issueBaseCreditsForIssuance(tx, {
          issuanceId: issuanceHeader.issuanceId,
          subscriptionId,
          kiloUserId: user.id,
          amountUsd: baseAmountUsd,
          providerPaymentId: getProviderPaymentId(purchase),
          description: `Kilo Pass base credits (${purchase.tier}, ${purchase.cadence})`,
        });

    if (isAppStoreSamePeriodUpgrade && previousStorePurchase?.expires_at) {
      await applyStoreUpgradeCreditAdjustments(tx, {
        issuanceId: issuanceHeader.issuanceId,
        subscriptionId,
        user,
        purchase,
        oldTier: activeSubscription.tier,
        oldPurchasedAtIso: previousStorePurchase.purchased_at,
        oldExpiresAtIso: previousStorePurchase.expires_at,
      });
    } else if (baseCreditsResult.wasIssued) {
      await updateKiloPassThresholdAfterBaseCredits(tx, {
        kiloUserId: user.id,
        baseAmountUsd,
      });
    }

    if (purchase.cadence === KiloPassCadence.Monthly) {
      const currentStreakMonths = await computeMonthlyKiloPassStreak(tx, {
        subscriptionId,
        issueMonth,
      });

      await tx
        .update(kilo_pass_subscriptions)
        .set({ current_streak_months: currentStreakMonths, next_yearly_issue_at: null })
        .where(eq(kilo_pass_subscriptions.id, subscriptionId));
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
        appStoreUpgradeApplied: isAppStoreSamePeriodUpgrade,
      },
    });

    return {
      subscriptionId,
      tier: purchase.tier,
      cadence: purchase.cadence,
      alreadyProcessed: false,
    };
  };

  if (params.dbOrTx !== undefined) {
    return run(params.dbOrTx);
  }
  return db.transaction(run);
}
