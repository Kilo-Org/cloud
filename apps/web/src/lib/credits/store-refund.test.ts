import { describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import { toMicrodollars } from '@/lib/utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

import { reverseStoreCreditPurchase } from './store-refund';
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

  it('is a no-op on a second reversal of the same purchase', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(100);
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars,
    });

    const first = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      })
    );
    const second = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      })
    );

    expect(second).toEqual({
      reversed: false,
      creditTransactionId: first.creditTransactionId,
      amountMicrodollars: 0,
    });
    // The balance never goes below zero through double counting.
    expect(await userBalance(user.id)).toBe(0);

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
