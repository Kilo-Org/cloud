import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  kilo_pass_issuances,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilo_pass_welcome_promo_store_payer_claims,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { computeMonthlyKiloPassBonusDecision } from '@kilocode/web-shared/lib/kilo-pass/bonus-decision';
import {
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
  KiloPassWelcomePromoEligibilityReason,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { getMonthlyWelcomePromoAccountContext } from '@kilocode/web-shared/lib/kilo-pass/welcome-promo-context';
import {
  completeStoreKiloPassPurchase,
  type ValidatedStoreKiloPassPurchase,
} from './store-subscription-completion';
import {
  claimStoreWelcomePromoPayer,
  getOrCreateInitialStoreWelcomePromoReason,
} from './store-welcome-promo-claim';

function applePurchase(
  overrides: Partial<ValidatedStoreKiloPassPurchase> = {}
): ValidatedStoreKiloPassPurchase {
  const originalTransactionId = `orig-${crypto.randomUUID()}`;
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'kilopass.tier49.monthly.v1',
    providerTransactionId: `tx-${crypto.randomUUID()}`,
    providerOriginalTransactionId: originalTransactionId,
    providerSubscriptionId: originalTransactionId,
    appAccountToken: crypto.randomUUID(),
    purchaseToken: null,
    environment: 'Sandbox',
    purchasedAtIso: '2026-05-01T12:00:00.000Z',
    expiresAtIso: '2026-06-01T12:00:00.000Z',
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
    rawPayload: { source: 'test' },
    ...overrides,
  };
}

function sameLineage(purchase: ValidatedStoreKiloPassPurchase) {
  return {
    providerOriginalTransactionId: purchase.providerOriginalTransactionId,
    providerSubscriptionId: purchase.providerSubscriptionId,
    productId: purchase.productId,
  };
}

async function initialIssuanceReason(subscriptionId: string) {
  const rows = await db
    .select({ reason: kilo_pass_issuances.initial_welcome_promo_eligibility_reason })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId));
  expect(rows).toHaveLength(1);
  return rows[0].reason;
}

async function insertSubscription(params: {
  kiloUserId: string;
  paymentProvider: KiloPassPaymentProvider.AppStore | KiloPassPaymentProvider.GooglePlay;
  providerSubscriptionId: string;
}): Promise<{ subscriptionId: string; issuanceId: string }> {
  const subscriptionRows = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.kiloUserId,
      payment_provider: params.paymentProvider,
      provider_subscription_id: params.providerSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      started_at: '2026-05-01T09:00:00.000Z',
    })
    .returning({ id: kilo_pass_subscriptions.id });
  const subscriptionId = subscriptionRows[0]?.id;
  if (!subscriptionId) throw new Error('failed to insert test subscription');

  const issuanceRows = await db
    .insert(kilo_pass_issuances)
    .values({
      kilo_pass_subscription_id: subscriptionId,
      issue_month: '2026-05-01',
      source:
        params.paymentProvider === KiloPassPaymentProvider.AppStore
          ? KiloPassIssuanceSource.AppStoreTransaction
          : KiloPassIssuanceSource.GooglePlayTransaction,
    })
    .returning({ id: kilo_pass_issuances.id });
  const issuanceId = issuanceRows[0]?.id;
  if (!issuanceId) throw new Error('failed to insert test issuance');

  return { subscriptionId, issuanceId };
}

describe('store welcome-promo purchaser claims', () => {
  it('records the first App Store claimant on the earliest issuance', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();

    const result = await completeStoreKiloPassPurchase({ user, purchase });

    await expect(initialIssuanceReason(result.subscriptionId)).resolves.toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
    );
    const claims = await db
      .select()
      .from(kilo_pass_welcome_promo_store_payer_claims)
      .where(eq(kilo_pass_welcome_promo_store_payer_claims.kilo_user_id, user.id));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      payment_provider: KiloPassPaymentProvider.AppStore,
      provider_payer_id: purchase.providerOriginalTransactionId,
      source_provider_transaction_id: purchase.providerTransactionId,
      source_provider_subscription_id: purchase.providerSubscriptionId,
      kilo_pass_subscription_id: result.subscriptionId,
    });
  });

  it('replays the same purchase without a second claim', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();
    const first = await completeStoreKiloPassPurchase({ user, purchase });

    const replayed = await db.transaction(tx =>
      claimStoreWelcomePromoPayer(tx, {
        purchase,
        kiloUserId: user.id,
        kiloPassSubscriptionId: first.subscriptionId,
      })
    );

    expect(replayed.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
    );
    const claims = await db
      .select({ paymentProvider: kilo_pass_welcome_promo_store_payer_claims.payment_provider })
      .from(kilo_pass_welcome_promo_store_payer_claims)
      .where(eq(kilo_pass_welcome_promo_store_payer_claims.kilo_user_id, user.id));
    expect(claims).toHaveLength(1);
    await expect(initialIssuanceReason(first.subscriptionId)).resolves.toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
    );
  });

  it('refuses to complete a store subscription owned by another account', async () => {
    const firstUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const firstPurchase = applePurchase();
    await completeStoreKiloPassPurchase({ user: firstUser, purchase: firstPurchase });

    const secondUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    await expect(
      completeStoreKiloPassPurchase({
        user: secondUser,
        purchase: applePurchase({
          ...sameLineage(firstPurchase),
          providerTransactionId: `tx-${crypto.randomUUID()}`,
        }),
      })
    ).rejects.toThrow('Store subscription already belongs to another user');
  });

  it('stores the monthly ramp for a second subscription on the same Google Play lineage', async () => {
    const firstUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const secondUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const rootToken = `play-token-${crypto.randomUUID()}`;
    const first = await insertSubscription({
      kiloUserId: firstUser.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerSubscriptionId: rootToken,
    });
    const replacementToken = `play-token-${crypto.randomUUID()}`;
    const second = await insertSubscription({
      kiloUserId: secondUser.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerSubscriptionId: replacementToken,
    });

    const firstClaim = await db.transaction(tx =>
      claimStoreWelcomePromoPayer(tx, {
        purchase: {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionId: `GPA.${crypto.randomUUID()}`,
          providerOriginalTransactionId: rootToken,
          providerSubscriptionId: rootToken,
          purchaseToken: rootToken,
        },
        kiloUserId: firstUser.id,
        kiloPassSubscriptionId: first.subscriptionId,
      })
    );
    expect(firstClaim.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
    );

    const secondPurchase = {
      paymentProvider: KiloPassPaymentProvider.GooglePlay as const,
      providerTransactionId: `GPA.${crypto.randomUUID()}`,
      providerOriginalTransactionId: replacementToken,
      providerSubscriptionId: replacementToken,
      purchaseToken: replacementToken,
      googlePlayReplacement: { linkedPurchaseToken: rootToken },
    };
    const reason = await db.transaction(tx =>
      getOrCreateInitialStoreWelcomePromoReason(tx, {
        purchase: secondPurchase,
        cadence: KiloPassCadence.Monthly,
        kiloUserId: secondUser.id,
        kiloPassSubscriptionId: second.subscriptionId,
        issuanceId: second.issuanceId,
      })
    );
    expect(reason).toBe(KiloPassWelcomePromoEligibilityReason.StorePayerPreviouslyClaimed);
    await expect(initialIssuanceReason(second.subscriptionId)).resolves.toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerPreviouslyClaimed
    );

    const context = await getMonthlyWelcomePromoAccountContext(db, {
      kiloUserId: secondUser.id,
      subscriptionId: second.subscriptionId,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
    });
    expect(context).toMatchObject({
      isFirstTimeSubscriberEver: true,
      welcomePromoPolicy: 'settled-payment-required',
      welcomePromoEligibilityReason:
        KiloPassWelcomePromoEligibilityReason.StorePayerPreviouslyClaimed,
    });

    const decision = computeMonthlyKiloPassBonusDecision({
      tier: KiloPassTier.Tier19,
      startedAtIso: '2026-05-01T09:00:00.000Z',
      streakMonths: 1,
      ...context,
    });
    expect(decision.shouldIssueFirstMonthPromo).toBe(false);
    expect(decision.bonusKind).toBe('monthly-ramp');

    // The first claimant keeps the permanently claimed lineage.
    const claims = await db
      .select()
      .from(kilo_pass_welcome_promo_store_payer_claims)
      .where(eq(kilo_pass_welcome_promo_store_payer_claims.provider_payer_id, rootToken));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kilo_pass_subscription_id).toBe(first.subscriptionId);
  });

  it('follows an intermediate replacement token back to the claimed lineage', async () => {
    const firstUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const secondUser = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    const rootToken = `play-token-${crypto.randomUUID()}`;
    const middleToken = `play-token-${crypto.randomUUID()}`;
    const lastToken = `play-token-${crypto.randomUUID()}`;

    const first = await insertSubscription({
      kiloUserId: firstUser.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerSubscriptionId: rootToken,
    });
    const firstClaim = await db.transaction(tx =>
      claimStoreWelcomePromoPayer(tx, {
        purchase: {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionId: `GPA.${crypto.randomUUID()}`,
          providerOriginalTransactionId: rootToken,
          providerSubscriptionId: rootToken,
          purchaseToken: rootToken,
        },
        kiloUserId: firstUser.id,
        kiloPassSubscriptionId: first.subscriptionId,
      })
    );
    expect(firstClaim.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerFirstClaim
    );

    // A plan change renames the subscription to the middle token and records its purchase.
    await db
      .update(kilo_pass_subscriptions)
      .set({ provider_subscription_id: middleToken })
      .where(eq(kilo_pass_subscriptions.id, first.subscriptionId));
    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: first.subscriptionId,
      kilo_user_id: firstUser.id,
      payment_provider: KiloPassPaymentProvider.GooglePlay,
      product_id: 'kilopass_tier49',
      provider_subscription_id: middleToken,
      provider_transaction_id: `GPA.${crypto.randomUUID()}`,
      app_account_token: null,
      purchase_token: middleToken,
      environment: 'Production',
      purchased_at: '2026-05-15T09:00:00.000Z',
      expires_at: '2026-06-15T09:00:00.000Z',
      raw_payload_json: {},
    });

    const second = await insertSubscription({
      kiloUserId: secondUser.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerSubscriptionId: lastToken,
    });
    const secondClaim = await db.transaction(tx =>
      claimStoreWelcomePromoPayer(tx, {
        purchase: {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionId: `GPA.${crypto.randomUUID()}`,
          providerOriginalTransactionId: lastToken,
          providerSubscriptionId: lastToken,
          purchaseToken: lastToken,
          googlePlayReplacement: { linkedPurchaseToken: middleToken },
        },
        kiloUserId: secondUser.id,
        kiloPassSubscriptionId: second.subscriptionId,
      })
    );
    expect(secondClaim.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerPreviouslyClaimed
    );

    const claims = await db
      .select()
      .from(kilo_pass_welcome_promo_store_payer_claims)
      .where(eq(kilo_pass_welcome_promo_store_payer_claims.provider_payer_id, rootToken));
    expect(claims).toHaveLength(1);
  });

  it('fails closed when the replacement chain has no traceable root', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const token = `play-token-${crypto.randomUUID()}`;
    const subscription = await insertSubscription({
      kiloUserId: user.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerSubscriptionId: token,
    });

    const claim = await db.transaction(tx =>
      claimStoreWelcomePromoPayer(tx, {
        purchase: {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionId: `GPA.${crypto.randomUUID()}`,
          providerOriginalTransactionId: token,
          providerSubscriptionId: token,
          purchaseToken: token,
          googlePlayReplacement: { linkedPurchaseToken: `play-token-${crypto.randomUUID()}` },
        },
        kiloUserId: user.id,
        kiloPassSubscriptionId: subscription.subscriptionId,
      })
    );

    expect(claim.welcomePromoReason).toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerUnresolved
    );
    const claims = await db
      .select({ paymentProvider: kilo_pass_welcome_promo_store_payer_claims.payment_provider })
      .from(kilo_pass_welcome_promo_store_payer_claims)
      .where(eq(kilo_pass_welcome_promo_store_payer_claims.kilo_user_id, user.id));
    expect(claims).toHaveLength(0);
  });

  it('fails closed when a purchase carries no durable purchaser identifier', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase({
      providerOriginalTransactionId: null,
      providerSubscriptionId: '',
    });
    const subscription = await insertSubscription({
      kiloUserId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId: `orig-${crypto.randomUUID()}`,
    });

    const reason = await db.transaction(tx =>
      getOrCreateInitialStoreWelcomePromoReason(tx, {
        purchase,
        cadence: KiloPassCadence.Monthly,
        kiloUserId: user.id,
        kiloPassSubscriptionId: subscription.subscriptionId,
        issuanceId: subscription.issuanceId,
      })
    );

    expect(reason).toBe(KiloPassWelcomePromoEligibilityReason.StorePayerUnresolved);
    await expect(initialIssuanceReason(subscription.subscriptionId)).resolves.toBe(
      KiloPassWelcomePromoEligibilityReason.StorePayerUnresolved
    );
  });

  it('leaves a renewal issuance without a purchaser decision', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();
    const first = await completeStoreKiloPassPurchase({ user, purchase });

    const renewalRows = await db
      .insert(kilo_pass_issuances)
      .values({
        kilo_pass_subscription_id: first.subscriptionId,
        issue_month: '2026-06-01',
        source: KiloPassIssuanceSource.AppStoreTransaction,
      })
      .returning({ id: kilo_pass_issuances.id });
    const renewalIssuanceId = renewalRows[0]?.id;
    if (!renewalIssuanceId) throw new Error('failed to insert renewal issuance');

    const reason = await db.transaction(tx =>
      getOrCreateInitialStoreWelcomePromoReason(tx, {
        purchase,
        cadence: KiloPassCadence.Monthly,
        kiloUserId: user.id,
        kiloPassSubscriptionId: first.subscriptionId,
        issuanceId: renewalIssuanceId,
      })
    );

    expect(reason).toBeNull();
    const rows = await db
      .select({
        reason: kilo_pass_issuances.initial_welcome_promo_eligibility_reason,
      })
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.id, renewalIssuanceId));
    expect(rows[0]?.reason).toBeNull();
  });
});
