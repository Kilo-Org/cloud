import { describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

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
      '2026-05-16T00:00:00.000Z'
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

    const [updatedUser] = await db
      .select({ totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser?.totalMicrodollarsAcquired).toBe(58_500_000);
    expect(creditRows.reduce((sum, row) => sum + row.amountMicrodollars, 0)).toBe(58_500_000);
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
