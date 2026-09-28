import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { toMicrodollars } from '@/lib/utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

import {
  getStoreCreditConsumptionMilliunits,
  reverseStoreCreditPurchase,
  STORE_FULL_MILLIUNITS,
} from './store-refund';
import { storeCreditPaymentId } from './store-products';

async function grantStoreCreditPack(params: {
  userId: string;
  paymentProvider: KiloPassPaymentProvider;
  providerTransactionId: string;
  amountMicrodollars: number;
}): Promise<void> {
  await db.insert(credit_transactions).values({
    kilo_user_id: params.userId,
    amount_microdollars: params.amountMicrodollars,
    is_free: false,
    description: 'Credit purchase via App Store',
    stripe_payment_id: storeCreditPaymentId(params.paymentProvider, params.providerTransactionId),
  });
  await db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: params.amountMicrodollars })
    .where(eq(kilocode_users.id, params.userId));
}

async function userBalance(userId: string): Promise<number> {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
  return user?.total_microdollars_acquired ?? 0;
}

describe('reverseStoreCreditPurchase', () => {
  it('reverses a granted credit pack once with the exact negative amount and balance decrement', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(50);
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars,
    });
    expect(await userBalance(user.id)).toBe(amountMicrodollars);

    const result = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );

    expect(result).toEqual({
      reversed: true,
      creditTransactionId: expect.any(String),
      amountMicrodollars,
    });
    expect(await userBalance(user.id)).toBe(0);

    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, result.creditTransactionId ?? ''),
    });
    expect(reversal).toMatchObject({
      kilo_user_id: user.id,
      amount_microdollars: -amountMicrodollars,
      is_free: false,
      credit_category: `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`,
      check_category_uniqueness: true,
    });
  });

  it('reverses a Google Play credit pack with the provider-scoped category', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `GPA.${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });

    const result = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );

    expect(result.reversed).toBe(true);
    expect(await userBalance(user.id)).toBe(0);
    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, result.creditTransactionId ?? ''),
    });
    expect(reversal).toMatchObject({
      amount_microdollars: -toMicrodollars(10),
      credit_category: `store-credit-refund:${KiloPassPaymentProvider.GooglePlay}:${providerTransactionId}`,
    });
  });

  it('reverses only the refunded share of a prorated refund', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });

    const result = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: 30_000,
      })
    );

    expect(result).toEqual({
      reversed: true,
      creditTransactionId: expect.any(String),
      amountMicrodollars: toMicrodollars(3),
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(7));
    const reversal = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, result.creditTransactionId ?? ''),
    });
    expect(reversal?.amount_microdollars).toBe(-toMicrodollars(3));
  });

  it.each([
    { refundedMilliunits: 250_000, expectedUsd: 10 },
    { refundedMilliunits: -5_000, expectedUsd: 0 },
  ])(
    'keeps the reversal within 0..granted for a refunded share of $refundedMilliunits',
    async ({ refundedMilliunits, expectedUsd }) => {
      const user = await insertTestUser();
      const providerTransactionId = `tx-${crypto.randomUUID()}`;
      await grantStoreCreditPack({
        userId: user.id,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        amountMicrodollars: toMicrodollars(10),
      });

      const result = await db.transaction(tx =>
        reverseStoreCreditPurchase(tx, {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerTransactionId,
          refundedMilliunits,
        })
      );

      expect(result.amountMicrodollars).toBe(toMicrodollars(expectedUsd));
      expect(await userBalance(user.id)).toBe(toMicrodollars(10 - expectedUsd));
    }
  );

  it('keeps the first reversal amount when a replay arrives after more spend', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });

    const first = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: 30_000,
      })
    );
    await db
      .update(kilocode_users)
      .set({ microdollars_used: toMicrodollars(5) })
      .where(eq(kilocode_users.id, user.id));
    const second = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );

    expect(second).toEqual({
      reversed: false,
      creditTransactionId: first.creditTransactionId,
      amountMicrodollars: 0,
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(7));

    const reversals = await db
      .select()
      .from(credit_transactions)
      .where(
        eq(
          credit_transactions.credit_category,
          `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`
        )
      );
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.amount_microdollars).toBe(-toMicrodollars(3));
  });

  it('is a no-op for a purchase Kilo never granted against', async () => {
    const user = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: toMicrodollars(5) })
      .where(eq(kilocode_users.id, user.id));

    const result = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );

    expect(result).toEqual({
      reversed: false,
      creditTransactionId: null,
      amountMicrodollars: 0,
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(5));
    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(0);
  });
});

describe('getStoreCreditConsumptionMilliunits', () => {
  it.each([
    { case: 'partly spent', acquiredUsd: 10, usedUsd: 7, expected: 70_000 },
    { case: 'fully unspent', acquiredUsd: 10, usedUsd: 0, expected: 0 },
    // Lifetime spend before the purchase is not spend from this pack.
    { case: 'untouched after $100 prior spend', acquiredUsd: 110, usedUsd: 100, expected: 0 },
    { case: 'unspent with other credits on top', acquiredUsd: 40, usedUsd: 15, expected: 0 },
    { case: 'fully spent', acquiredUsd: 10, usedUsd: 10, expected: STORE_FULL_MILLIUNITS },
    { case: 'overdrawn', acquiredUsd: 10, usedUsd: 12, expected: STORE_FULL_MILLIUNITS },
  ])(
    'counts a $10 pack as consumed against the balance ($case)',
    async ({ acquiredUsd, usedUsd, expected }) => {
      const user = await insertTestUser();
      const providerTransactionId = `tx-${crypto.randomUUID()}`;
      await grantStoreCreditPack({
        userId: user.id,
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        amountMicrodollars: toMicrodollars(10),
      });
      await db
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: toMicrodollars(acquiredUsd),
          microdollars_used: toMicrodollars(usedUsd),
        })
        .where(eq(kilocode_users.id, user.id));

      await expect(
        getStoreCreditConsumptionMilliunits(db, {
          paymentProvider: KiloPassPaymentProvider.AppStore,
          providerTransactionId,
        })
      ).resolves.toBe(expected);
    }
  );

  it('returns null for a purchase Kilo never granted', async () => {
    await expect(
      getStoreCreditConsumptionMilliunits(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
      })
    ).resolves.toBeNull();
  });
});
