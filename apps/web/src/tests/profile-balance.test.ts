import { describe, test, expect } from '@jest/globals';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

// Mock next/server's after function which requires request context
jest.mock('next/server', () => {
  return {
    ...jest.requireActual('next/server'),
    after: jest.fn(),
  };
});

describe('getBalanceForUser (migrated users)', () => {
  test('should calculate balance locally for migrated users', async () => {
    const microdollars_used = 500_000;
    const total_microdollars_acquired = 2_000_000; // 2 USD
    const expectedBalance = (total_microdollars_acquired - microdollars_used) / 1_000_000; // 1.5 USD

    const user = await insertTestUser({
      microdollars_used,
      total_microdollars_acquired,
    });

    const result = await getBalanceForUser(user);
    expect(result).toEqual({
      balance: expectedBalance,
    });
  });

  test('should return user balance from user cache', async () => {
    const microdollars_used = 500_000;
    const total_microdollars_acquired = 2_000_000; // 2 USD
    const userBalance = (total_microdollars_acquired - microdollars_used) / 1_000_000; // Convert to USD

    const user = await insertTestUser({
      microdollars_used,
      total_microdollars_acquired,
    });

    const result = await getBalanceForUser(user);
    expect(result).toEqual({ balance: userBalance });
  });

  test('should calculate balance locally even with stale cache', async () => {
    const microdollars_used = 500_000;
    const total_microdollars_acquired = 2_000_000; // 2 USD
    const expectedBalance = (total_microdollars_acquired - microdollars_used) / 1_000_000;

    const user = await insertTestUser({
      microdollars_used,
      total_microdollars_acquired,
    });

    const result = await getBalanceForUser(user);
    expect(result).toEqual({
      balance: expectedBalance,
    });
  });
});

describe('getBalanceForUser credit expiry cut-off', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  // Due half an hour before the cut-off's starting point, so the outcome depends only on
  // the jitter the caller injects.
  const expiry = new Date(now.getTime() - 30 * 60 * 1000);

  async function insertUserWithDueCredit() {
    const user = await insertTestUser({
      total_microdollars_acquired: 1_000_000,
      microdollars_used: 0,
      next_credit_expiration_at: expiry.toISOString(),
    });

    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 1_000_000,
      is_free: true,
      expiry_date: expiry.toISOString(),
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Expiring credits',
    });

    return user;
  }

  async function readExpirationState(userId: string) {
    const [row] = await db
      .select({
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));
    const expired = await db
      .select({ amount_microdollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, userId),
          eq(credit_transactions.credit_category, 'credits_expired')
        )
      );
    return {
      ...row,
      next_credit_expiration_at: row.next_credit_expiration_at
        ? new Date(row.next_credit_expiration_at).toISOString()
        : null,
      expired,
    };
  }

  test('processes a credit that expired before the cut-off and reports the reduced balance', async () => {
    const user = await insertUserWithDueCredit();

    const result = await getBalanceForUser(user, { now, expiryJitterHours: 0 });

    expect(result.balance).toBe(0);
    expect(await readExpirationState(user.id)).toEqual({
      total_microdollars_acquired: 0,
      next_credit_expiration_at: null,
      expired: [{ amount_microdollars: -1_000_000 }],
    });
  });

  test('keeps a credit that expires after the cut-off and reports the unchanged balance', async () => {
    const user = await insertUserWithDueCredit();

    const result = await getBalanceForUser(user, { now, expiryJitterHours: 1 });

    expect(result.balance).toBe(1);
    expect(await readExpirationState(user.id)).toEqual({
      total_microdollars_acquired: 1_000_000,
      next_credit_expiration_at: expiry.toISOString(),
      expired: [],
    });
  });
});
