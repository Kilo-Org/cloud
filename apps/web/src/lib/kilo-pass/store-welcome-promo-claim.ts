import 'server-only';

import {
  kilo_pass_issuances,
  kilo_pass_store_purchases,
  kilo_pass_welcome_promo_store_payer_claims,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassWelcomePromoEligibilityReason,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { and, asc, eq } from 'drizzle-orm';

/**
 * The parts of a verified store purchase that identify its purchaser.
 *
 * - App Store: the original transaction identifier names the subscription lineage of one Apple
 *   account within the subscription group, so every renewal and plan change of it carries the same
 *   value.
 * - Google Play: the purchase token identifies one subscription, and a plan change starts a new
 *   token that links back to the previous one, so the lineage root is the first token of the chain.
 */
export type StoreWelcomePromoPurchase = {
  paymentProvider: KiloPassPaymentProvider.AppStore | KiloPassPaymentProvider.GooglePlay;
  providerTransactionId: string;
  providerOriginalTransactionId: string | null;
  providerSubscriptionId: string;
  purchaseToken: string | null;
  googlePlayReplacement?: { linkedPurchaseToken: string } | undefined;
};

export type StoreWelcomePromoPayerClaimResult = {
  welcomePromoReason: KiloPassWelcomePromoEligibilityReason;
};

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function getSourceSubscriptionId(purchase: StoreWelcomePromoPurchase): string | null {
  return purchase.paymentProvider === KiloPassPaymentProvider.AppStore
    ? (trimmedOrNull(purchase.providerOriginalTransactionId) ??
        trimmedOrNull(purchase.providerSubscriptionId))
    : (trimmedOrNull(purchase.purchaseToken) ?? trimmedOrNull(purchase.providerSubscriptionId));
}

async function resolveStorePayerId(
  tx: DrizzleTransaction,
  purchase: StoreWelcomePromoPurchase
): Promise<string | null> {
  const sourceSubscriptionId = getSourceSubscriptionId(purchase);
  if (purchase.paymentProvider === KiloPassPaymentProvider.AppStore) {
    return sourceSubscriptionId;
  }
  if (sourceSubscriptionId === null) return null;

  const linkedPurchaseToken = trimmedOrNull(purchase.googlePlayReplacement?.linkedPurchaseToken);
  if (linkedPurchaseToken === null) return sourceSubscriptionId;

  const claimedByToken = await tx
    .select({
      providerPayerId: kilo_pass_welcome_promo_store_payer_claims.provider_payer_id,
    })
    .from(kilo_pass_welcome_promo_store_payer_claims)
    .where(
      and(
        eq(
          kilo_pass_welcome_promo_store_payer_claims.payment_provider,
          KiloPassPaymentProvider.GooglePlay
        ),
        eq(
          kilo_pass_welcome_promo_store_payer_claims.source_provider_subscription_id,
          linkedPurchaseToken
        )
      )
    )
    .limit(1);
  const inherited = claimedByToken[0]?.providerPayerId;
  if (inherited) return inherited;

  // An earlier token of the chain may have claimed under a different source token after a rename,
  // so follow the purchase that carried it to its subscription's claim.
  const linkedPurchase = await tx
    .select({
      kiloPassSubscriptionId: kilo_pass_store_purchases.kilo_pass_subscription_id,
    })
    .from(kilo_pass_store_purchases)
    .where(
      and(
        eq(kilo_pass_store_purchases.payment_provider, KiloPassPaymentProvider.GooglePlay),
        eq(kilo_pass_store_purchases.purchase_token, linkedPurchaseToken)
      )
    )
    .orderBy(asc(kilo_pass_store_purchases.purchased_at))
    .limit(1);
  const linkedSubscriptionId = linkedPurchase[0]?.kiloPassSubscriptionId;
  if (!linkedSubscriptionId) return null;

  const claimedBySubscription = await tx
    .select({
      providerPayerId: kilo_pass_welcome_promo_store_payer_claims.provider_payer_id,
    })
    .from(kilo_pass_welcome_promo_store_payer_claims)
    .where(
      and(
        eq(
          kilo_pass_welcome_promo_store_payer_claims.payment_provider,
          KiloPassPaymentProvider.GooglePlay
        ),
        eq(
          kilo_pass_welcome_promo_store_payer_claims.kilo_pass_subscription_id,
          linkedSubscriptionId
        )
      )
    )
    .limit(1);

  // No claim reached through the chain leaves the lineage root unknown; the caller denies the promo.
  return claimedBySubscription[0]?.providerPayerId ?? null;
}

/**
 * Claims the store purchaser identity behind one purchase. The claim is permanent: the first
 * purchase of a lineage earns the introductory promo, and a later purchase of the same lineage
 * does not.
 */
export async function claimStoreWelcomePromoPayer(
  tx: DrizzleTransaction,
  params: {
    purchase: StoreWelcomePromoPurchase;
    kiloUserId: string;
    kiloPassSubscriptionId: string;
  }
): Promise<StoreWelcomePromoPayerClaimResult> {
  const sourceProviderSubscriptionId = getSourceSubscriptionId(params.purchase);
  const providerPayerId = await resolveStorePayerId(tx, params.purchase);
  if (sourceProviderSubscriptionId === null || providerPayerId === null) {
    return { welcomePromoReason: KiloPassWelcomePromoEligibilityReason.StorePayerUnresolved };
  }

  const inserted = await tx
    .insert(kilo_pass_welcome_promo_store_payer_claims)
    .values({
      payment_provider: params.purchase.paymentProvider,
      provider_payer_id: providerPayerId,
      source_provider_transaction_id: params.purchase.providerTransactionId,
      source_provider_subscription_id: sourceProviderSubscriptionId,
      kilo_user_id: params.kiloUserId,
      kilo_pass_subscription_id: params.kiloPassSubscriptionId,
    })
    .onConflictDoNothing()
    .returning({
      kiloPassSubscriptionId: kilo_pass_welcome_promo_store_payer_claims.kilo_pass_subscription_id,
    });

  if (inserted[0]) {
    return { welcomePromoReason: KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim };
  }

  const existing = await tx
    .select({
      kiloPassSubscriptionId: kilo_pass_welcome_promo_store_payer_claims.kilo_pass_subscription_id,
    })
    .from(kilo_pass_welcome_promo_store_payer_claims)
    .where(
      and(
        eq(
          kilo_pass_welcome_promo_store_payer_claims.payment_provider,
          params.purchase.paymentProvider
        ),
        eq(kilo_pass_welcome_promo_store_payer_claims.provider_payer_id, providerPayerId)
      )
    )
    .limit(1);

  const claimed = existing[0];
  if (!claimed) {
    throw new Error('Store welcome-promo claim attribution conflict');
  }

  // The same subscription replayed its first purchase: it keeps its own claim.
  return {
    welcomePromoReason:
      claimed.kiloPassSubscriptionId === params.kiloPassSubscriptionId
        ? KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
        : KiloPassWelcomePromoEligibilityReason.StorePayerPreviouslyClaimed,
  };
}

/**
 * Records the welcome-promo purchaser decision on the earliest monthly issuance of a store
 * subscription, the same place and once-only rule the Stripe invoice path uses. Renewals, plan
 * switches, and yearly purchases return null and change nothing.
 */
export async function getOrCreateInitialStoreWelcomePromoReason(
  tx: DrizzleTransaction,
  params: {
    purchase: StoreWelcomePromoPurchase;
    cadence: KiloPassCadence;
    kiloUserId: string;
    kiloPassSubscriptionId: string;
    issuanceId: string;
  }
): Promise<KiloPassWelcomePromoEligibilityReason | null> {
  if (params.cadence !== KiloPassCadence.Monthly) return null;

  const earliestIssuance = await tx
    .select({
      id: kilo_pass_issuances.id,
      eligibilityReason: kilo_pass_issuances.initial_welcome_promo_eligibility_reason,
    })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, params.kiloPassSubscriptionId))
    .orderBy(asc(kilo_pass_issuances.issue_month))
    .limit(1);

  const earliest = earliestIssuance[0];
  if (!earliest || earliest.id !== params.issuanceId) return null;
  if (earliest.eligibilityReason !== null) return earliest.eligibilityReason;

  const claim = await claimStoreWelcomePromoPayer(tx, {
    purchase: params.purchase,
    kiloUserId: params.kiloUserId,
    kiloPassSubscriptionId: params.kiloPassSubscriptionId,
  });

  await tx
    .update(kilo_pass_issuances)
    .set({ initial_welcome_promo_eligibility_reason: claim.welcomePromoReason })
    .where(eq(kilo_pass_issuances.id, params.issuanceId));

  return claim.welcomePromoReason;
}
