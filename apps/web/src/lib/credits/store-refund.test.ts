import { NotificationTypeV2 } from '@apple/app-store-server-library';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { credit_transactions, kilo_pass_store_events, kilocode_users } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { processTopUp } from '@kilocode/web-shared/lib/credits';
import { processLocalExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import { getCreditBlocks } from '@/lib/getCreditBlocks';
import { closeCreditExpirationsForBalanceReset } from '@kilocode/web-shared/lib/credit-refund';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  findEffectiveStoreCreditRefundEvent,
  getStoreCreditConsumptionMilliunits,
  isStoreRefundDeliverySuperseded,
  restoreStoreCreditPurchase,
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

/**
 * The event row a claim handler writes, in the shape the App Store handler
 * stores it: the decoded notification type and the store's signed date in
 * `payload_json`, the store ids in their own columns.
 */
async function insertStoreEvent(params: {
  paymentProvider: KiloPassPaymentProvider;
  notificationType: string;
  providerTransactionId: string;
  providerSubscriptionId?: string;
  signedDate?: number | null;
  processedAt: string | null;
}): Promise<string> {
  const eventId = `event-${crypto.randomUUID()}`;
  await db.insert(kilo_pass_store_events).values({
    payment_provider: params.paymentProvider,
    event_id: eventId,
    provider_transaction_id: params.providerTransactionId,
    provider_subscription_id: params.providerSubscriptionId ?? null,
    product_id: 'credits.usd10.v1',
    environment: 'Sandbox',
    payload_json: {
      notificationType: params.notificationType,
      signedDate: params.signedDate ?? null,
    },
    processing_started_at: params.processedAt ?? new Date().toISOString(),
    processed_at: params.processedAt,
  });
  return eventId;
}

function creditRowsForCategory(creditCategory: string) {
  return db
    .select({
      id: credit_transactions.id,
      amountMicrodollars: credit_transactions.amount_microdollars,
      isFree: credit_transactions.is_free,
    })
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, creditCategory))
    .orderBy(credit_transactions.created_at);
}

describe('reverseStoreCreditPurchase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function advanceToExpiry(date: Date) {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
        'hrtime',
        'queueMicrotask',
      ],
    });
    jest.setSystemTime(date);
  }
  it.each([
    [0, 4],
    [3, 4],
    [8, 4],
    [10, 4],
    [0, 10],
    [3, 10],
    [10, 10],
  ])('expires only unused unrefunded value (used=%s, refund=%s)', async (used, refund) => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerTransactionId = crypto.randomUUID();
    const params = { paymentProvider: KiloPassPaymentProvider.AppStore, providerTransactionId };
    await processTopUp(
      user,
      1000,
      {
        type: 'stripe',
        stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
      },
      { skipPostTopUpFreeStuff: true }
    );
    await db
      .update(kilocode_users)
      .set({ microdollars_used: toMicrodollars(used) })
      .where(eq(kilocode_users.id, user.id));
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: refund * 10_000 })
    );
    const refunded = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    const expiry = new Date(refunded!.next_credit_expiration_at!);
    const rows = await db.query.credit_transactions.findMany({
      where: eq(credit_transactions.kilo_user_id, user.id),
    });
    expect(
      getCreditBlocks(rows, new Date(), refunded!, user.id).creditBlocks.reduce(
        (sum, block) => sum + block.balance_mUsd,
        0
      )
    ).toBe(toMicrodollars(Math.max(0, 10 - used - refund)));
    await processLocalExpirations(refunded!, expiry);
    advanceToExpiry(expiry);
    expect((await userBalance(user.id)) - toMicrodollars(used)).toBe(
      toMicrodollars(Math.min(0, 10 - used - refund))
    );
    await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
    expect((await userBalance(user.id)) - toMicrodollars(used)).toBe(0);
    await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
    expect((await userBalance(user.id)) - toMicrodollars(used)).toBe(0);
  });

  it.each([0, 3, 10])(
    'refund after expiration claws back consumed value only (used=%s)',
    async used => {
      const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
      const providerTransactionId = crypto.randomUUID();
      const params = { paymentProvider: KiloPassPaymentProvider.AppStore, providerTransactionId };
      await processTopUp(
        user,
        1000,
        {
          type: 'stripe',
          stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
        },
        { skipPostTopUpFreeStuff: true }
      );
      await db
        .update(kilocode_users)
        .set({ microdollars_used: toMicrodollars(used) })
        .where(eq(kilocode_users.id, user.id));
      const current = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      await processLocalExpirations(current!, new Date(current!.next_credit_expiration_at!));
      advanceToExpiry(new Date(current!.next_credit_expiration_at!));
      await db.transaction(tx =>
        reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: STORE_FULL_MILLIUNITS })
      );
      expect(await userBalance(user.id)).toBe(0);
      await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
      expect(await userBalance(user.id)).toBe(toMicrodollars(used));
      await db.transaction(tx =>
        reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: STORE_FULL_MILLIUNITS })
      );
      expect(await userBalance(user.id)).toBe(0);
    }
  );

  it('a reversal before expiry restores eligibility without renewing the deadline', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerTransactionId = crypto.randomUUID();
    const params = { paymentProvider: KiloPassPaymentProvider.AppStore, providerTransactionId };
    await processTopUp(
      user,
      1000,
      {
        type: 'stripe',
        stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
      },
      { skipPostTopUpFreeStuff: true }
    );
    const original = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: 40_000 })
    );
    await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
    const restored = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(restored!.next_credit_expiration_at).toBe(original!.next_credit_expiration_at);
    expect(await userBalance(user.id)).toBe(toMicrodollars(10));
    await processLocalExpirations(restored!, new Date(restored!.next_credit_expiration_at!));
    expect(await userBalance(user.id)).toBe(0);
  });

  it.each([true, false])(
    'does not let overlapping grants claim refunded consumption twice (used before refund=%s)',
    async usedBeforeRefund => {
      const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
      const providerTransactionId = crypto.randomUUID();
      const params = { paymentProvider: KiloPassPaymentProvider.AppStore, providerTransactionId };
      await processTopUp(
        user,
        1000,
        {
          type: 'stripe',
          stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
        },
        { skipPostTopUpFreeStuff: true }
      );
      await processTopUp(
        user,
        1000,
        { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
        { skipPostTopUpFreeStuff: true }
      );
      if (usedBeforeRefund)
        await db
          .update(kilocode_users)
          .set({ microdollars_used: toMicrodollars(3) })
          .where(eq(kilocode_users.id, user.id));
      await db.transaction(tx =>
        reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: STORE_FULL_MILLIUNITS })
      );
      await db
        .update(kilocode_users)
        .set({ microdollars_used: toMicrodollars(3) })
        .where(eq(kilocode_users.id, user.id));
      const current = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      const afterBothExpire = new Date(
        new Date(current!.next_credit_expiration_at!).getTime() + 86400_000
      );
      await processLocalExpirations(current!, afterBothExpire);
      advanceToExpiry(afterBothExpire);
      expect((await userBalance(user.id)) - toMicrodollars(3)).toBe(
        usedBeforeRefund ? -toMicrodollars(3) : 0
      );
      await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
      expect((await userBalance(user.id)) - toMicrodollars(3)).toBe(0);
    }
  );

  it('does not deduct a fully refunded unused pack again at expiration', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await processTopUp(
      user,
      1000,
      {
        type: 'stripe',
        stripe_payment_id: storeCreditPaymentId(
          KiloPassPaymentProvider.AppStore,
          providerTransactionId
        ),
      },
      { skipPostTopUpFreeStuff: true }
    );
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    expect(await userBalance(user.id)).toBe(0);
    const refundedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    await processLocalExpirations(
      refundedUser!,
      new Date(refundedUser!.next_credit_expiration_at!)
    );
    expect(await userBalance(user.id)).toBe(0);
  });

  it.each([true, false])(
    'settles an overdue grant atomically even without the scheduler hint (hint=%s)',
    async hasHint => {
      const user = await insertTestUser({
        total_microdollars_acquired: toMicrodollars(10),
        microdollars_used: toMicrodollars(3),
      });
      const providerTransactionId = crypto.randomUUID();
      const params = {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      };
      const expiry = new Date(Date.now() - 86400_000).toISOString();
      const [grant] = await db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: toMicrodollars(10),
          is_free: false,
          stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
          expiry_date: expiry,
          expiration_baseline_microdollars_used: 0,
          original_baseline_microdollars_used: 0,
        })
        .returning();
      await db
        .update(kilocode_users)
        .set({ next_credit_expiration_at: hasHint ? expiry : null })
        .where(eq(kilocode_users.id, user.id));
      await expect(
        db.transaction(async tx => {
          await reverseStoreCreditPurchase(tx, params);
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');
      expect(await userBalance(user.id)).toBe(toMicrodollars(10));
      expect(
        await db.query.credit_transactions.findFirst({
          where: eq(credit_transactions.original_transaction_id, grant.id),
        })
      ).toBeUndefined();
      await db.transaction(tx => reverseStoreCreditPurchase(tx, params));
      expect(await userBalance(user.id)).toBe(0);
      await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
      expect(await userBalance(user.id)).toBe(toMicrodollars(3));
    }
  );

  it('a balance reset closes the old grant without expiring a subsequent purchase', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    await processTopUp(
      user,
      1000,
      { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
      { skipPostTopUpFreeStuff: true }
    );
    const current = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    await db.transaction(async tx => {
      await closeCreditExpirationsForBalanceReset(tx, user.id, 0);
      await tx.insert(credit_transactions).values({
        kilo_user_id: user.id,
        is_free: true,
        amount_microdollars: -toMicrodollars(10),
        credit_category: 'stripe-dispute-enforcement',
      });
      await tx
        .update(kilocode_users)
        .set({ total_microdollars_acquired: 0 })
        .where(eq(kilocode_users.id, user.id));
    });
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after!.next_credit_expiration_at).toBeNull();
    advanceToExpiry(new Date(Date.now() + 86400_000));
    await processTopUp(
      user,
      500,
      { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
      { skipPostTopUpFreeStuff: true }
    );
    const repurchased = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    await processLocalExpirations(repurchased!, new Date(current!.next_credit_expiration_at!));
    expect(await userBalance(user.id)).toBe(toMicrodollars(5));
  });

  it("does not reserve an earlier grant's consumption for a later fully refunded grant", async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    const providerTransactionId = crypto.randomUUID();
    const params = { paymentProvider: KiloPassPaymentProvider.AppStore, providerTransactionId };
    await processTopUp(
      user,
      300,
      { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
      { skipPostTopUpFreeStuff: true }
    );
    await processTopUp(
      user,
      1000,
      {
        type: 'stripe',
        stripe_payment_id: storeCreditPaymentId(params.paymentProvider, providerTransactionId),
      },
      { skipPostTopUpFreeStuff: true }
    );
    await processTopUp(
      user,
      1000,
      { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
      { skipPostTopUpFreeStuff: true }
    );
    await db
      .update(kilocode_users)
      .set({ microdollars_used: toMicrodollars(3) })
      .where(eq(kilocode_users.id, user.id));
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, { ...params, refundedMilliunits: STORE_FULL_MILLIUNITS })
    );
    await db
      .update(kilocode_users)
      .set({ microdollars_used: toMicrodollars(6) })
      .where(eq(kilocode_users.id, user.id));
    const current = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    const expiry = new Date(new Date(current!.next_credit_expiration_at!).getTime() + 86400_000);
    await processLocalExpirations(current!, expiry);
    advanceToExpiry(expiry);
    expect(await userBalance(user.id)).toBe(toMicrodollars(6));
    await db.transaction(tx => restoreStoreCreditPurchase(tx, params));
    expect(await userBalance(user.id)).toBe(toMicrodollars(6));
  });

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

describe('restoreStoreCreditPurchase', () => {
  it('credits back exactly what a full refund clawed from a granted pack', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const amountMicrodollars = toMicrodollars(10);
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars,
    });
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    expect(await userBalance(user.id)).toBe(0);

    const result = await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      })
    );

    expect(result).toEqual({
      restored: true,
      creditTransactionId: expect.any(String),
      amountMicrodollars,
    });
    expect(await userBalance(user.id)).toBe(amountMicrodollars);
    const restorations = await creditRowsForCategory(
      `store-credit-refund-reversal:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`
    );
    expect(restorations).toEqual([
      {
        id: result.creditTransactionId,
        amountMicrodollars,
        isFree: false,
      },
    ]);
  });

  it.each([
    { case: 'an App Store pack', provider: KiloPassPaymentProvider.AppStore, refunded: 30_000 },
    { case: 'a Google Play pack', provider: KiloPassPaymentProvider.GooglePlay, refunded: 30_000 },
  ])('restores only the share $case clawed back', async ({ provider, refunded }) => {
    const user = await insertTestUser();
    const providerTransactionId =
      provider === KiloPassPaymentProvider.GooglePlay
        ? `GPA.${crypto.randomUUID()}`
        : `tx-${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: provider,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: provider,
        providerTransactionId,
        refundedMilliunits: refunded,
      })
    );

    const result = await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, { paymentProvider: provider, providerTransactionId })
    );

    expect(result.amountMicrodollars).toBe(toMicrodollars(3));
    expect(await userBalance(user.id)).toBe(toMicrodollars(10));
  });

  it('restores once when the reversal is delivered again', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });
    await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    const first = await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      })
    );
    await db
      .update(kilocode_users)
      .set({ microdollars_used: toMicrodollars(4) })
      .where(eq(kilocode_users.id, user.id));

    const second = await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      })
    );

    expect(second).toEqual({
      restored: false,
      creditTransactionId: first.creditTransactionId,
      amountMicrodollars: 0,
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(10));
    expect(
      await creditRowsForCategory(
        `store-credit-refund-reversal:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`
      )
    ).toHaveLength(1);
  });

  it('restores nothing for a pack Kilo never clawed back', async () => {
    const user = await insertTestUser();
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: toMicrodollars(5) })
      .where(eq(kilocode_users.id, user.id));

    const result = await db.transaction(tx =>
      restoreStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId: `tx-${crypto.randomUUID()}`,
      })
    );

    expect(result).toEqual({
      restored: false,
      creditTransactionId: null,
      amountMicrodollars: 0,
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(5));
  });

  it('claws the pack back again when the store refunds it after a reversal', async () => {
    const user = await insertTestUser();
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await grantStoreCreditPack({
      userId: user.id,
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionId,
      amountMicrodollars: toMicrodollars(10),
    });
    // First refund claws the unspent third, and its reversal gives it back.
    await db.transaction(async tx => {
      await reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: 30_000,
      });
      await restoreStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
      });
    });
    expect(await userBalance(user.id)).toBe(toMicrodollars(10));

    // The store refunds the pack a second time: the credits must not stay granted.
    const secondRefund = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );

    expect(secondRefund.reversed).toBe(true);
    expect(await userBalance(user.id)).toBe(0);
    expect(
      await creditRowsForCategory(
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}`
      )
    ).toEqual([{ id: expect.any(String), amountMicrodollars: -toMicrodollars(3), isFree: false }]);
    expect(
      await creditRowsForCategory(
        `store-credit-refund:${KiloPassPaymentProvider.AppStore}:${providerTransactionId}:2`
      )
    ).toEqual([
      {
        id: secondRefund.creditTransactionId,
        amountMicrodollars: -toMicrodollars(10),
        isFree: false,
      },
    ]);

    // A replay of the second refund finds its clawback in force.
    const replay = await db.transaction(tx =>
      reverseStoreCreditPurchase(tx, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionId,
        refundedMilliunits: STORE_FULL_MILLIUNITS,
      })
    );
    expect(replay).toEqual({
      reversed: false,
      creditTransactionId: secondRefund.creditTransactionId,
      amountMicrodollars: 0,
    });
    expect(await userBalance(user.id)).toBe(0);
  });
});

describe('findEffectiveStoreCreditRefundEvent', () => {
  it('reports a processed refund that no reversal has reinstated', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    const eventId = await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processedAt: new Date().toISOString(),
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toEqual({ eventId, notificationType: NotificationTypeV2.REFUND });
  });

  it('reports no refund once a reversal the store signed later is processed', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processedAt: '2026-05-01T00:00:00.000Z',
    });
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processedAt: '2026-05-01T00:00:01.000Z',
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toBeNull();
  });

  it('reports no refund when a reversal is processed before the older refund it reverses', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    // The reversal is delivered first and Kilo processes it first, but the
    // refund it reverses was signed earlier: the refund is the superseded one.
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processedAt: '2026-05-01T00:00:00.000Z',
    });
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processedAt: '2026-05-01T00:00:01.000Z',
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toBeNull();
  });

  it('keeps the refund effective when a refund and its reversal are signed in the same millisecond', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    for (const notificationType of [
      NotificationTypeV2.REFUND,
      NotificationTypeV2.REFUND_REVERSED,
    ]) {
      await insertStoreEvent({
        paymentProvider: KiloPassPaymentProvider.AppStore,
        notificationType,
        providerTransactionId,
        signedDate: 1_777_700_000_000,
        processedAt: '2026-05-01T00:00:00.000Z',
      });
    }

    const event = await findEffectiveStoreCreditRefundEvent(db, {
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerTransactionIds: [providerTransactionId],
    });
    expect(event?.notificationType).toBe(NotificationTypeV2.REFUND);
  });

  it('falls back to processing order for a delivery with no signed date', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: null,
      processedAt: '2026-05-01T00:00:00.000Z',
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toMatchObject({ notificationType: NotificationTypeV2.REFUND });

    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: null,
      processedAt: '2026-05-01T00:00:01.000Z',
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toBeNull();
  });

  it('ignores a claimed delivery that is still being processed', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processedAt: null,
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
      })
    ).resolves.toBeNull();
  });

  it('reports a Play refund under either the order id or the purchase token', async () => {
    const orderId = `GPA.${crypto.randomUUID()}`;
    const purchaseToken = crypto.randomUUID();
    const eventId = await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.GooglePlay,
      notificationType: 'voided_purchase',
      providerTransactionId: orderId,
      providerSubscriptionId: purchaseToken,
      signedDate: 1_777_700_000_000,
      processedAt: new Date().toISOString(),
    });

    for (const providerTransactionIds of [[orderId], [purchaseToken]]) {
      await expect(
        findEffectiveStoreCreditRefundEvent(db, {
          paymentProvider: KiloPassPaymentProvider.GooglePlay,
          providerTransactionIds,
        })
      ).resolves.toEqual({ eventId, notificationType: 'voided_purchase' });
    }
  });

  it('never reports a refund for Stripe', async () => {
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.Stripe,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId: `tx-${crypto.randomUUID()}`,
      signedDate: 1_777_700_000_000,
      processedAt: new Date().toISOString(),
    });

    await expect(
      findEffectiveStoreCreditRefundEvent(db, {
        paymentProvider: KiloPassPaymentProvider.Stripe,
        providerTransactionIds: [`tx-${crypto.randomUUID()}`],
      })
    ).resolves.toBeNull();
  });
});

describe('isStoreRefundDeliverySuperseded', () => {
  it('supersedes a refund the store signed before a reversal Kilo processed', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;
    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND_REVERSED,
      providerTransactionId,
      signedDate: 1_777_700_060_000,
      processedAt: new Date().toISOString(),
    });

    await expect(
      isStoreRefundDeliverySuperseded(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
        signedDateMs: 1_777_700_000_000,
      })
    ).resolves.toBe(true);

    // The delivery the store signed later carries the purchase forward.
    await expect(
      isStoreRefundDeliverySuperseded(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
        signedDateMs: 1_777_700_120_000,
      })
    ).resolves.toBe(false);
  });

  it('treats a delivery with no signed date as arriving now', async () => {
    const providerTransactionId = `tx-${crypto.randomUUID()}`;

    await expect(
      isStoreRefundDeliverySuperseded(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
        signedDateMs: null,
      })
    ).resolves.toBe(false);

    await insertStoreEvent({
      paymentProvider: KiloPassPaymentProvider.AppStore,
      notificationType: NotificationTypeV2.REFUND,
      providerTransactionId,
      signedDate: 1_777_700_000_000,
      processedAt: new Date().toISOString(),
    });

    await expect(
      isStoreRefundDeliverySuperseded(db, {
        paymentProvider: KiloPassPaymentProvider.AppStore,
        providerTransactionIds: [providerTransactionId],
        signedDateMs: null,
      })
    ).resolves.toBe(false);
  });
});
