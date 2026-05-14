import { describe, expect, it } from '@jest/globals';
import { and, eq, sql } from 'drizzle-orm';

import {
  credit_transactions,
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { getMonthlyPriceUsd } from './bonus';
import { KiloPassCadence, KiloPassIssuanceItemKind, KiloPassTier } from './enums';
import { KiloPassIssuanceSource, KiloPassPaymentProvider } from './enums';
import {
  completeStoreKiloPassPurchase,
  type ValidatedStoreKiloPassPurchase,
} from './store-subscription-completion';

function applePurchase(
  overrides: Partial<ValidatedStoreKiloPassPurchase> = {}
): ValidatedStoreKiloPassPurchase {
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'kilopass.tier49.monthly.v1',
    providerTransactionId: `tx-${crypto.randomUUID()}`,
    providerOriginalTransactionId: `orig-${crypto.randomUUID()}`,
    providerSubscriptionId: `orig-${crypto.randomUUID()}`,
    appAccountToken: crypto.randomUUID(),
    purchaseToken: `jws-${crypto.randomUUID()}`,
    environment: 'Sandbox',
    purchasedAtIso: '2026-05-01T12:00:00.000Z',
    expiresAtIso: '2026-06-01T12:00:00.000Z',
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
    rawPayload: { source: 'test' },
    ...overrides,
  };
}

describe('completeStoreKiloPassPurchase', () => {
  it('creates an active app store subscription and issues base credits once', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();

    const result = await completeStoreKiloPassPurchase({ user, purchase });

    expect(result).toEqual({
      subscriptionId: expect.any(String),
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      alreadyProcessed: false,
    });

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.kilo_user_id, user.id));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      payment_provider: KiloPassPaymentProvider.AppStore,
      provider_subscription_id: purchase.providerSubscriptionId,
      stripe_subscription_id: null,
      status: 'active',
      tier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      current_streak_months: 1,
    });

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, user.id));
    expect(storePurchases).toHaveLength(1);
    expect(storePurchases[0]?.app_account_token).toBe(purchase.appAccountToken);

    const issuances = await db
      .select()
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, result.subscriptionId));
    expect(issuances).toHaveLength(1);
    expect(issuances[0]?.source).toBe(KiloPassIssuanceSource.AppStoreTransaction);

    const items = await db
      .select({
        amountUsd: kilo_pass_issuance_items.amount_usd,
        creditTransactionId: kilo_pass_issuance_items.credit_transaction_id,
      })
      .from(kilo_pass_issuance_items)
      .where(
        and(
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuances[0]?.id ?? ''),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
        )
      );
    expect(items).toHaveLength(1);
    expect(items[0]?.amountUsd).toBe(getMonthlyPriceUsd(KiloPassTier.Tier49));

    const creditRows = await db
      .select({ amountMicrodollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(eq(credit_transactions.id, items[0]?.creditTransactionId ?? ''));
    expect(creditRows[0]?.amountMicrodollars).toBe(49_000_000);
  });

  it('returns idempotently when the same provider transaction is replayed by the same user', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();

    const first = await completeStoreKiloPassPurchase({ user, purchase });
    const replay = await completeStoreKiloPassPurchase({ user, purchase });

    expect(replay).toEqual({ ...first, alreadyProcessed: true });

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, purchase.providerTransactionId));
    expect(storePurchases).toHaveLength(1);
  });

  it('does not persist signed App Store JWS or account tokens in retained purchase JSON', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const appAccountToken = crypto.randomUUID();
    const signedTransactionJws = `signed-jws-${crypto.randomUUID()}`;
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        appAccountToken,
        purchaseToken: signedTransactionJws,
        providerTransactionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerSubscriptionId,
        rawPayload: {
          appAccountToken,
          signedTransactionInfo: signedTransactionJws,
          purchaseToken: signedTransactionJws,
          transactionId: providerTransactionId,
          originalTransactionId: providerSubscriptionId,
          nested: {
            appAccountToken,
            transactionId: providerTransactionId,
          },
        },
      }),
    });

    const [storePurchase] = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.provider_transaction_id, providerTransactionId));

    expect(storePurchase?.app_account_token).toBe(appAccountToken);
    expect(storePurchase?.purchase_token).toBeNull();
    expect(storePurchase?.provider_subscription_id).toBe(providerSubscriptionId);

    const persistedPayloadJson = JSON.stringify(storePurchase?.raw_payload_json);
    expect(persistedPayloadJson).not.toContain(appAccountToken);
    expect(persistedPayloadJson).not.toContain(signedTransactionJws);
    expect(storePurchase?.raw_payload_json).toMatchObject({
      appAccountToken: null,
      signedTransactionInfo: null,
      purchaseToken: null,
      transactionId: providerTransactionId,
      originalTransactionId: providerSubscriptionId,
      nested: {
        appAccountToken: null,
        transactionId: providerTransactionId,
      },
    });
  });

  it('returns idempotently when the same provider transaction is completed concurrently', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchase = applePurchase();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => completeStoreKiloPassPurchase({ user, purchase }))
    );

    const subscriptionIds = new Set(results.map(result => result.subscriptionId));
    expect(subscriptionIds.size).toBe(1);
    expect(results.filter(result => result.alreadyProcessed)).toHaveLength(3);

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.payment_provider, purchase.paymentProvider),
          eq(kilo_pass_subscriptions.provider_subscription_id, purchase.providerSubscriptionId)
        )
      );
    expect(subscriptions).toHaveLength(1);

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(
        and(
          eq(kilo_pass_store_purchases.payment_provider, purchase.paymentProvider),
          eq(kilo_pass_store_purchases.provider_transaction_id, purchase.providerTransactionId)
        )
      );
    expect(storePurchases).toHaveLength(1);

    const issuances = await db
      .select()
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, results[0]?.subscriptionId ?? ''));
    expect(issuances).toHaveLength(1);

    const items = await db
      .select()
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuances[0]?.id ?? ''));
    expect(items).toHaveLength(1);
  });

  it('rejects concurrent different provider subscriptions for the same user', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const purchases = Array.from({ length: 4 }, () => applePurchase());

    const results = await Promise.allSettled(
      purchases.map(purchase => completeStoreKiloPassPurchase({ user, purchase }))
    );

    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect(result.reason).toEqual(new Error('You already have an active Kilo Pass subscription'));
    }

    const liveSubscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(
        and(
          eq(kilo_pass_subscriptions.kilo_user_id, user.id),
          eq(kilo_pass_subscriptions.status, 'active')
        )
      );
    expect(liveSubscriptions).toHaveLength(1);

    const storePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, user.id));
    expect(storePurchases).toHaveLength(1);
  });

  it('increments the streak for consecutive App Store monthly renewals', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-01-05T12:00:00.000Z',
      }),
    });
    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-02-05T12:00:00.000Z',
      }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, first.subscriptionId),
    });

    expect(subscription?.current_streak_months).toBe(2);
  });

  it('preserves the original subscription start date across App Store renewals', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;
    const firstTransactionId = `tx-${crypto.randomUUID()}`;
    const renewalTransactionId = `tx-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: firstTransactionId,
        purchasedAtIso: '2026-05-01T00:00:00.000Z',
        expiresAtIso: '2026-06-01T00:00:00.000Z',
      }),
    });
    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: renewalTransactionId,
        purchasedAtIso: '2026-06-01T00:00:00.000Z',
        expiresAtIso: '2026-07-01T00:00:00.000Z',
      }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, first.subscriptionId),
    });
    expect(subscription?.started_at ? new Date(subscription.started_at).toISOString() : null).toBe(
      '2026-05-01T00:00:00.000Z'
    );
    expect(subscription?.current_streak_months).toBe(2);

    const renewalPurchase = await db.query.kilo_pass_store_purchases.findFirst({
      where: eq(kilo_pass_store_purchases.provider_transaction_id, renewalTransactionId),
    });
    expect(
      renewalPurchase?.purchased_at ? new Date(renewalPurchase.purchased_at).toISOString() : null
    ).toBe('2026-06-01T00:00:00.000Z');
    expect(
      renewalPurchase?.expires_at ? new Date(renewalPurchase.expires_at).toISOString() : null
    ).toBe('2026-07-01T00:00:00.000Z');
  });

  it('claws back prorated old tier credits and issues full new tier credits for App Store upgrades', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier19.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-01T00:00:00.000Z',
        expiresAtIso: '2026-05-31T00:00:00.000Z',
        tier: KiloPassTier.Tier19,
      }),
    });

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier49.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-16T00:00:00.000Z',
        expiresAtIso: '2026-06-16T00:00:00.000Z',
        tier: KiloPassTier.Tier49,
      }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId),
    });
    expect(subscription?.tier).toBe(KiloPassTier.Tier49);
    expect(subscription?.started_at ? new Date(subscription.started_at).toISOString() : null).toBe(
      '2026-05-01T00:00:00.000Z'
    );

    const creditRows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id))
      .orderBy(credit_transactions.created_at);

    expect(creditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: 19_000_000,
          description: 'Kilo Pass base credits (tier_19, monthly)',
        }),
        expect.objectContaining({
          amountMicrodollars: -9_500_000,
          description: 'Kilo Pass upgrade refund clawback (tier_19)',
        }),
        expect.objectContaining({
          amountMicrodollars: 49_000_000,
          description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
        }),
      ])
    );
    expect(creditRows).toHaveLength(3);

    const baseItems = await db
      .select({
        amountUsd: kilo_pass_issuance_items.amount_usd,
        description: credit_transactions.description,
      })
      .from(kilo_pass_issuance_items)
      .innerJoin(
        kilo_pass_issuances,
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
      )
      .innerJoin(
        credit_transactions,
        eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
      )
      .where(
        and(
          eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription?.id ?? ''),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
        )
      );
    expect(baseItems).toEqual([
      {
        amountUsd: 49,
        description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
      },
    ]);

    const [updatedUser] = await db
      .select({ totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser?.totalMicrodollarsAcquired).toBe(58_500_000);
    expect(creditRows.reduce((sum, row) => sum + row.amountMicrodollars, 0)).toBe(58_500_000);
  });

  it('rewrites the original period issuance when an App Store upgrade crosses a calendar month boundary', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier19.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-01-31T00:00:00.000Z',
        expiresAtIso: '2026-02-28T00:00:00.000Z',
        tier: KiloPassTier.Tier19,
      }),
    });

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier49.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-02-01T00:00:00.000Z',
        expiresAtIso: '2026-03-01T00:00:00.000Z',
        tier: KiloPassTier.Tier49,
      }),
    });

    const creditRows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id))
      .orderBy(credit_transactions.created_at);

    expect(creditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -18_321_429,
          description: 'Kilo Pass upgrade refund clawback (tier_19)',
        }),
        expect.objectContaining({
          amountMicrodollars: 49_000_000,
          description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
        }),
      ])
    );

    const issuances = await db
      .select({
        id: kilo_pass_issuances.id,
        issueMonth: kilo_pass_issuances.issue_month,
      })
      .from(kilo_pass_issuances)
      .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, first.subscriptionId))
      .orderBy(kilo_pass_issuances.issue_month);

    expect(issuances).toEqual([
      {
        id: expect.any(String),
        issueMonth: '2026-01-01',
      },
    ]);

    const baseItems = await db
      .select({
        amountUsd: kilo_pass_issuance_items.amount_usd,
        description: credit_transactions.description,
        issueMonth: kilo_pass_issuances.issue_month,
      })
      .from(kilo_pass_issuance_items)
      .innerJoin(
        kilo_pass_issuances,
        eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
      )
      .innerJoin(
        credit_transactions,
        eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
      )
      .where(
        and(
          eq(kilo_pass_issuances.kilo_pass_subscription_id, first.subscriptionId),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
        )
      );

    expect(baseItems).toEqual([
      {
        amountUsd: 49,
        description: 'Kilo Pass upgrade base credits (tier_49, monthly)',
        issueMonth: '2026-01-01',
      },
    ]);

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, first.subscriptionId),
    });
    expect(subscription?.current_streak_months).toBe(1);
  });

  it('reverses existing bonus state when an App Store upgrade replaces the base item', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier19.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-01T00:00:00.000Z',
        expiresAtIso: '2026-05-31T00:00:00.000Z',
        tier: KiloPassTier.Tier19,
      }),
    });

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, first.subscriptionId),
    });
    expect(issuance).toBeDefined();

    const [bonusTransaction, promoTransaction] = await Promise.all([
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: 9_500_000,
          is_free: true,
          description: 'test Kilo Pass bonus credits',
          credit_category: `test-kilo-pass-bonus-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
      db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: 4_750_000,
          is_free: true,
          description: 'test Kilo Pass promo credits',
          credit_category: `test-kilo-pass-promo-${crypto.randomUUID()}`,
        })
        .returning({ id: credit_transactions.id }),
    ]);
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${14_250_000}`,
      })
      .where(eq(kilocode_users.id, user.id));
    await db.insert(kilo_pass_issuance_items).values([
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.Bonus,
        credit_transaction_id: bonusTransaction[0]?.id ?? '',
        amount_usd: 9.5,
        bonus_percent_applied: 0.5,
      },
      {
        kilo_pass_issuance_id: issuance?.id ?? '',
        kind: KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
        credit_transaction_id: promoTransaction[0]?.id ?? '',
        amount_usd: 4.75,
        bonus_percent_applied: 0.25,
      },
    ]);

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier49.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-16T00:00:00.000Z',
        expiresAtIso: '2026-06-16T00:00:00.000Z',
        tier: KiloPassTier.Tier49,
      }),
    });

    const remainingItems = await db
      .select({
        kind: kilo_pass_issuance_items.kind,
        amountUsd: kilo_pass_issuance_items.amount_usd,
      })
      .from(kilo_pass_issuance_items)
      .where(eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''));
    expect(remainingItems).toEqual([{ kind: KiloPassIssuanceItemKind.Base, amountUsd: 49 }]);

    const creditRows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(creditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -9_500_000,
          description: 'Kilo Pass upgrade bonus clawback',
        }),
        expect.objectContaining({
          amountMicrodollars: -4_750_000,
          description: 'Kilo Pass upgrade promo clawback',
        }),
      ])
    );

    const [updatedUser] = await db
      .select({ totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser?.totalMicrodollarsAcquired).toBe(58_500_000);
  });

  it('keeps one current base item across multiple App Store upgrades in the same month', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier19.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-01T00:00:00.000Z',
        expiresAtIso: '2026-05-31T00:00:00.000Z',
        tier: KiloPassTier.Tier19,
      }),
    });

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier49.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-10T00:00:00.000Z',
        expiresAtIso: '2026-06-10T00:00:00.000Z',
        tier: KiloPassTier.Tier49,
      }),
    });
    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier199.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-20T00:00:00.000Z',
        expiresAtIso: '2026-06-20T00:00:00.000Z',
        tier: KiloPassTier.Tier199,
      }),
    });

    const issuance = await db.query.kilo_pass_issuances.findFirst({
      where: eq(kilo_pass_issuances.kilo_pass_subscription_id, first.subscriptionId),
    });
    const currentBaseItems = await db
      .select({
        amountUsd: kilo_pass_issuance_items.amount_usd,
        description: credit_transactions.description,
      })
      .from(kilo_pass_issuance_items)
      .innerJoin(
        credit_transactions,
        eq(kilo_pass_issuance_items.credit_transaction_id, credit_transactions.id)
      )
      .where(
        and(
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuance?.id ?? ''),
          eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
        )
      );
    expect(currentBaseItems).toEqual([
      {
        amountUsd: 199,
        description: 'Kilo Pass upgrade base credits (tier_199, monthly)',
      },
    ]);
  });

  it('does not cap the App Store upgrade clawback when prior credits were spent', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier19.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-01T00:00:00.000Z',
        expiresAtIso: '2026-05-31T00:00:00.000Z',
        tier: KiloPassTier.Tier19,
      }),
    });

    await db
      .update(kilocode_users)
      .set({ microdollars_used: 20_000_000 })
      .where(eq(kilocode_users.id, user.id));

    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        productId: 'kilopass.tier49.monthly.v1',
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-05-16T00:00:00.000Z',
        expiresAtIso: '2026-06-16T00:00:00.000Z',
        tier: KiloPassTier.Tier49,
      }),
    });

    const creditRows = await db
      .select({
        amountMicrodollars: credit_transactions.amount_microdollars,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));

    expect(creditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amountMicrodollars: -9_500_000,
          description: 'Kilo Pass upgrade refund clawback (tier_19)',
        }),
      ])
    );

    const [updatedUser] = await db
      .select({
        totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
        microdollarsUsed: kilocode_users.microdollars_used,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser).toEqual(
      expect.objectContaining({
        totalMicrodollarsAcquired: 58_500_000,
        microdollarsUsed: 20_000_000,
      })
    );
  });

  it('resets the App Store monthly streak when a renewal month is missing', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const first = await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-01-05T12:00:00.000Z',
      }),
    });
    await completeStoreKiloPassPurchase({
      user,
      purchase: applePurchase({
        providerSubscriptionId,
        providerOriginalTransactionId: providerSubscriptionId,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        purchasedAtIso: '2026-03-05T12:00:00.000Z',
      }),
    });

    const subscription = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.id, first.subscriptionId),
    });

    expect(subscription?.current_streak_months).toBe(1);
  });

  it('rejects when the same provider transaction is replayed by another user', async () => {
    const firstUser = await insertTestUser();
    const secondUser = await insertTestUser();
    const purchase = applePurchase();

    await completeStoreKiloPassPurchase({ user: firstUser, purchase });

    await expect(completeStoreKiloPassPurchase({ user: secondUser, purchase })).rejects.toThrow(
      'Store transaction already belongs to another user'
    );
  });

  it('rejects when another user completes a different transaction for an owned provider subscription', async () => {
    const firstUser = await insertTestUser({ total_microdollars_acquired: 0 });
    const secondUser = await insertTestUser({ total_microdollars_acquired: 0 });
    const providerSubscriptionId = `orig-${crypto.randomUUID()}`;

    const firstPurchase = applePurchase({
      providerSubscriptionId,
      providerOriginalTransactionId: providerSubscriptionId,
      providerTransactionId: `tx-${crypto.randomUUID()}`,
      purchasedAtIso: '2026-05-01T00:00:00.000Z',
      expiresAtIso: '2026-06-01T00:00:00.000Z',
    });

    await completeStoreKiloPassPurchase({ user: firstUser, purchase: firstPurchase });

    const secondPurchase = applePurchase({
      providerSubscriptionId,
      providerOriginalTransactionId: providerSubscriptionId,
      providerTransactionId: `tx-${crypto.randomUUID()}`,
      purchasedAtIso: '2026-06-01T00:00:00.000Z',
      expiresAtIso: '2026-07-01T00:00:00.000Z',
    });

    await expect(
      completeStoreKiloPassPurchase({ user: secondUser, purchase: secondPurchase })
    ).rejects.toThrow('Store subscription already belongs to another user');

    const subscriptions = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.provider_subscription_id, providerSubscriptionId));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.kilo_user_id).toBe(firstUser.id);

    const secondUserStorePurchases = await db
      .select()
      .from(kilo_pass_store_purchases)
      .where(eq(kilo_pass_store_purchases.kilo_user_id, secondUser.id));
    expect(secondUserStorePurchases).toHaveLength(0);

    const secondUserCreditTransactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, secondUser.id));
    expect(secondUserCreditTransactions).toHaveLength(0);
  });

  it('rejects when the user already has an active non-ended Kilo Pass subscription', async () => {
    const user = await insertTestUser();
    await completeStoreKiloPassPurchase({ user, purchase: applePurchase() });

    await expect(
      completeStoreKiloPassPurchase({ user, purchase: applePurchase() })
    ).rejects.toThrow('You already have an active Kilo Pass subscription');
  });
});
