import { describe, test, expect } from '@jest/globals';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';

// Mock next/server's after function which requires request context
jest.mock('next/server', () => {
  return {
    ...jest.requireActual('next/server'),
    after: jest.fn(),
  };
});

describe('getBalanceForUser (migrated users)', () => {
  test('excludes outstanding inference holds without treating them as incurred usage', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 2_000_000,
      microdollars_used: 500_000,
      inference_microdollars_held: 1_000_000,
    });

    expect(await getBalanceForUser(user)).toEqual({ balance: 0.5 });
    expect(user.microdollars_used).toBe(500_000);
  });

  test('preserves negative spendable balance when holds exceed remaining credit', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 2_000_000,
      microdollars_used: 500_000,
      inference_microdollars_held: 2_000_000,
    });

    expect(await getBalanceForUser(user)).toEqual({ balance: -0.5 });
  });

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
