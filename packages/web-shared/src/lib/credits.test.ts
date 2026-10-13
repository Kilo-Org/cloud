import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { processTopUp } from './credits';
import { paidCreditExpiration } from './paid-credit-expiration';
import { processLocalExpirations } from './creditExpiration';

// Mock firstTopupBonus to avoid side effects (it creates additional transactions)
jest.mock('@kilocode/web-shared/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/email', () => ({
  sendCreditsTopUpEmail: jest.fn(async () => ({ sent: true })),
}));

describe('processTopUp', () => {
  test.each([[[300]], [[1000]], [[300, 1000]], [[1000, 1000]]])(
    'does not expire debt repayment twice for purchases %j',
    async purchases => {
      const user = await insertTestUser({
        total_microdollars_acquired: 0,
        microdollars_used: 5_000_000,
      });
      for (const amount of purchases)
        await processTopUp(
          user,
          amount,
          { type: 'stripe', stripe_payment_id: crypto.randomUUID() },
          { skipPostTopUpFreeStuff: true }
        );
      const current = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      await processLocalExpirations(current!, new Date('2099-01-01T00:00:00Z'));
      const expired = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user.id),
      });
      expect(expired!.total_microdollars_acquired - expired!.microdollars_used).toBe(
        Math.min(0, purchases.reduce((sum, cents) => sum + cents * 10_000, 0) - 5_000_000)
      );
    }
  );

  test.each([false, true])('expires only unused new paid credits (auto=%s)', async isAutoTopUp => {
    const user = await insertTestUser({
      total_microdollars_acquired: 20_000_000,
      microdollars_used: 0,
    });
    const [legacy] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        is_free: false,
        amount_microdollars: 20_000_000,
      })
      .returning();
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 3_000_000 })
      .where(eq(kilocode_users.id, user.id));
    const config = { type: 'stripe' as const, stripe_payment_id: crypto.randomUUID() };
    const before = paidCreditExpiration();
    await processTopUp(user, 1000, config, { isAutoTopUp, skipPostTopUpFreeStuff: true });
    const credit = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, config.stripe_payment_id),
    });
    expect(credit).toMatchObject({
      original_baseline_microdollars_used: 3_000_000,
      expiration_baseline_microdollars_used: 3_000_000,
    });
    expect(new Date(credit!.expiry_date!).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(new Date(credit!.expiry_date!).getTime()).toBeLessThanOrEqual(
      paidCreditExpiration().getTime()
    );
    await processTopUp(user, 1000, config, { skipPostTopUpFreeStuff: true });
    expect(
      await db.query.credit_transactions.findFirst({
        where: eq(credit_transactions.id, credit!.id),
      })
    ).toEqual(credit);
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 7_000_000 })
      .where(eq(kilocode_users.id, user.id));
    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updated!.next_credit_expiration_at).toBe(credit!.expiry_date);
    await processLocalExpirations(updated!, new Date(credit!.expiry_date!));
    const expired = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(expired!.total_microdollars_acquired).toBe(24_000_000);
    expect(expired!.next_credit_expiration_at).toBeNull();
    expect(
      await db.query.credit_transactions.findFirst({ where: eq(credit_transactions.id, legacy.id) })
    ).toEqual(legacy);
  });

  test('preserves an earlier scheduled expiration and legacy replay', async () => {
    const earlier = new Date(Date.now() + 86400_000).toISOString();
    const user = await insertTestUser({ next_credit_expiration_at: earlier });
    const config = { type: 'stripe' as const, stripe_payment_id: crypto.randomUUID() };
    const [legacy] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: user.id,
        is_free: false,
        amount_microdollars: 1000,
        stripe_payment_id: config.stripe_payment_id,
      })
      .returning();
    expect(await processTopUp(user, 100, config, { skipPostTopUpFreeStuff: true })).toBe(false);
    expect(
      await db.query.credit_transactions.findFirst({ where: eq(credit_transactions.id, legacy.id) })
    ).toEqual(legacy);
    await processTopUp(
      user,
      100,
      { ...config, stripe_payment_id: crypto.randomUUID() },
      { skipPostTopUpFreeStuff: true }
    );
    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(new Date(updated!.next_credit_expiration_at!).toISOString()).toBe(earlier);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should prevent duplicate credit transactions via unique constraint', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `stripe-test-duplicate-${Date.now()}-${Math.random()}`;
    const amountInCents = 500;

    // First top-up should succeed
    const result1 = await processTopUp(user, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(result1).toBe(true);

    // Second top-up with same stripe_payment_id should be rejected
    const result2 = await processTopUp(user, amountInCents, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(result2).toBe(false);

    // Only one transaction with this stripe_payment_id should exist
    const transactions = await db.query.credit_transactions.findMany({
      where: and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.stripe_payment_id, stripePaymentId)
      ),
    });
    expect(transactions.length).toBe(1);
  });
});
