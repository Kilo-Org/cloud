import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { credit_transactions } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { processTopUp } from './credits';

// Mock firstTopupBonus to avoid side effects (it creates additional transactions)
jest.mock('@/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

describe('processTopUp', () => {
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
