import { db } from '@/lib/drizzle';
import { processAppleCreditPurchase, reverseAppleCreditPurchase } from './purchases';
import { apple_iap_purchases, credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';

function makeTransaction(transactionId: string) {
  return {
    ...baseTransaction,
    transactionId,
    originalTransactionId: `${transactionId}-original`,
  };
}

const baseTransaction = {
  transactionId: 'apple-txn-base',
  originalTransactionId: 'apple-original-1',
  bundleId: 'com.kilocode.kiloapp',
  productId: 'com.kilocode.kiloapp.credits.small.999',
  purchaseDate: Date.UTC(2026, 0, 1),
  environment: 'Sandbox' as const,
  appAccountToken: undefined,
};

describe('processAppleCreditPurchase', () => {
  it('grants configured credits for a valid purchase', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });

    const result = await processAppleCreditPurchase({
      user,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => makeTransaction('apple-txn-grant'),
    });

    expect(result).toEqual({
      creditedCents: 699,
      creditedMicrodollars: 6_990_000,
      alreadyProcessed: false,
    });

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(6_990_000);

    const purchase = await db.query.apple_iap_purchases.findFirst({
      where: eq(apple_iap_purchases.apple_transaction_id, 'apple-txn-grant'),
    });
    expect(purchase?.credit_transaction_id).toBeTruthy();
  });

  it('does not double grant duplicate submissions by the owning user', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0 });

    await processAppleCreditPurchase({
      user,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => makeTransaction('apple-txn-duplicate-owner'),
    });
    const replay = await processAppleCreditPurchase({
      user,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => makeTransaction('apple-txn-duplicate-owner'),
    });

    expect(replay.alreadyProcessed).toBe(true);

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(6_990_000);
  });

  it('rejects duplicate transaction submitted by a different user', async () => {
    const owner = await insertTestUser();
    const attacker = await insertTestUser();

    await processAppleCreditPurchase({
      user: owner,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => makeTransaction('apple-txn-duplicate-other-user'),
    });

    await expect(
      processAppleCreditPurchase({
        user: attacker,
        transactionJws: 'signed-transaction',
        verifyTransaction: async () => makeTransaction('apple-txn-duplicate-other-user'),
      })
    ).rejects.toThrow('Apple transaction already belongs to another user');
  });

  it('rejects unknown product IDs', async () => {
    const user = await insertTestUser();

    await expect(
      processAppleCreditPurchase({
        user,
        transactionJws: 'signed-transaction',
        verifyTransaction: async () => ({ ...baseTransaction, productId: 'unknown' }),
      })
    ).rejects.toThrow('Apple product is not enabled');
  });

  it('rejects wrong bundle IDs', async () => {
    const user = await insertTestUser();

    await expect(
      processAppleCreditPurchase({
        user,
        transactionJws: 'signed-transaction',
        verifyTransaction: async () => ({ ...baseTransaction, bundleId: 'com.example.other' }),
      })
    ).rejects.toThrow('Apple transaction bundle mismatch');
  });

  it('rejects revoked transactions at completion time', async () => {
    const user = await insertTestUser();

    await expect(
      processAppleCreditPurchase({
        user,
        transactionJws: 'signed-transaction',
        verifyTransaction: async () => ({ ...baseTransaction, revocationDate: Date.now() }),
      })
    ).rejects.toThrow('Apple transaction has been revoked');
  });

  it('reverses refunds and allows negative balance', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 1_000_000,
    });

    await processAppleCreditPurchase({
      user,
      transactionJws: 'signed-transaction',
      verifyTransaction: async () => makeTransaction('apple-txn-refund'),
    });
    await reverseAppleCreditPurchase({
      appleTransactionId: 'apple-txn-refund',
      reversalReason: 'refunded',
    });

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(0);
    expect(
      (updatedUser?.total_microdollars_acquired ?? 0) - (updatedUser?.microdollars_used ?? 0)
    ).toBe(-1_000_000);

    const transactions = await db.query.credit_transactions.findMany({
      where: eq(credit_transactions.kilo_user_id, user.id),
    });
    expect(transactions.map(t => t.amount_microdollars).sort((a, b) => a - b)).toEqual([
      -6_990_000, 6_990_000,
    ]);
  });
});
