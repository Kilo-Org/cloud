import { db } from '@/lib/drizzle';
import { kilocode_users, credit_transactions, microdollar_usage } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { recomputeUserBalances, computeUserBalanceUpdates } from './recomputeUserBalances';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('recomputeUserBalances', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(credit_transactions);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(microdollar_usage);
    jest.clearAllMocks();
  });

  test('should fail if user not found', async () => {
    const result = await recomputeUserBalances({ userId: 'non-existent-user' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('User not found');
    }
  });

  test('should recompute successfully with no accounting error when data is consistent', async () => {
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    const user = await insertTestUser();

    // Add some credit transactions
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 10_000_000, // $10
      is_free: false,
      credit_category: 'purchase',
      created_at: oldDate,
      original_baseline_microdollars_used: 0, // Correct baseline
    });

    // Add some usage
    await db.insert(microdollar_usage).values({
      kilo_user_id: user.id,
      cost: 2_000_000, // $2
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: oldDate,
    });

    // Update user to match
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 10_000_000,
        microdollars_used: 2_000_000,
      })
      .where(eq(kilocode_users.id, user.id));

    const result = await recomputeUserBalances({ userId: user.id });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accounting_error_mUsd).toBe(0);
    }

    // Verify no adjustment transaction
    const adjustmentTx = await db.query.credit_transactions.findFirst({
      where: and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.credit_category, 'accounting_adjustment')
      ),
    });
    expect(adjustmentTx).toBeUndefined();
  });

  test('should detect accounting error and insert adjustment when user balance differs from ledger', async () => {
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    const user = await insertTestUser();

    // Ledger says: Acquired $10, Used $0
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 10_000_000,
      is_free: false,
      credit_category: 'purchase',
      created_at: oldDate,
      original_baseline_microdollars_used: 0,
    });

    // User says: Acquired $12, Used $0 (Discrepancy of +$2)
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 12_000_000,
        microdollars_used: 0,
      })
      .where(eq(kilocode_users.id, user.id));

    const result = await recomputeUserBalances({ userId: user.id });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accounting_error_mUsd).toBe(2_000_000);
    }

    // Verify adjustment transaction
    const adjustmentTx = await db.query.credit_transactions.findFirst({
      where: and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.credit_category, 'accounting_adjustment')
      ),
    });
    expect(adjustmentTx).toBeDefined();
    expect(adjustmentTx?.amount_microdollars).toBe(2_000_000);

    // Verify user total acquired is updated to include adjustment (should match original user total)
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updatedUser?.total_microdollars_acquired).toBe(12_000_000);
  });

  test('should update baselines correctly', async () => {
    const user = await insertTestUser();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const usageDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 hours ago
    const creditDate = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString(); // 2.5 hours ago

    // Usage: $1
    await db.insert(microdollar_usage).values({
      kilo_user_id: user.id,
      cost: 1_000_000,
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: usageDate,
    });

    // Credit: $5 (Expiring)
    // Baseline should be $1 (usage before credit)
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 5_000_000,
      is_free: true,
      credit_category: 'promo',
      expiry_date: futureDate,
      expiration_baseline_microdollars_used: null, // Incorrect/Missing
      original_baseline_microdollars_used: 0, // Incorrect
      created_at: creditDate,
    });

    // User state doesn't matter for baseline computation, but let's set it consistent
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 5_000_000,
        microdollars_used: 1_000_000,
      })
      .where(eq(kilocode_users.id, user.id));

    const result = await recomputeUserBalances({ userId: user.id });
    expect(result.success).toBe(true);

    // Verify baselines
    const tx = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.kilo_user_id, user.id),
    });
    expect(tx?.original_baseline_microdollars_used).toBe(1_000_000);
    expect(tx?.expiration_baseline_microdollars_used).toBe(1_000_000);
  });

  test('should not mutate in dry run', async () => {
    const user = await insertTestUser();

    // Discrepancy setup
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 10_000_000,
      is_free: false,
      credit_category: 'purchase',
      original_baseline_microdollars_used: 0,
    });

    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 12_000_000, // +$2 discrepancy
        microdollars_used: 0,
      })
      .where(eq(kilocode_users.id, user.id));

    const result = await recomputeUserBalances({ userId: user.id, dryRun: true });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.accounting_error_mUsd).toBe(2_000_000);
    }

    // Verify NO adjustment transaction
    const adjustmentTx = await db.query.credit_transactions.findFirst({
      where: and(
        eq(credit_transactions.kilo_user_id, user.id),
        eq(credit_transactions.credit_category, 'accounting_adjustment')
      ),
    });
    expect(adjustmentTx).toBeUndefined();
  });

  test('should skip baseline updates when values already match', () => {
    const usageDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const creditDate = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = computeUserBalanceUpdates({
      user: {
        id: 'test-user',
        updated_at: new Date().toISOString(),
        microdollars_used: 1_000_000,
        total_microdollars_acquired: 5_000_000,
      },
      usageRecords: [{ cost: 1_000_000, created_at: usageDate }],
      creditTransactions: [
        {
          id: 'tx-1',
          created_at: creditDate,
          expiry_date: futureDate,
          amount_microdollars: 5_000_000,
          original_baseline_microdollars_used: 1_000_000, // Already correct
          expiration_baseline_microdollars_used: 1_000_000, // Already correct
          description: null,
          is_free: true,
          original_transaction_id: null,
        },
      ],
    });

    expect(result.updatesForOriginalBaseline).toHaveLength(0);
    expect(result.updatesForExpirationBaseline).toHaveLength(0);
  });

  test('should generate baseline updates when values differ', () => {
    const usageDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const creditDate = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const result = computeUserBalanceUpdates({
      user: {
        id: 'test-user',
        updated_at: new Date().toISOString(),
        microdollars_used: 1_000_000,
        total_microdollars_acquired: 5_000_000,
      },
      usageRecords: [{ cost: 1_000_000, created_at: usageDate }],
      creditTransactions: [
        {
          id: 'tx-1',
          created_at: creditDate,
          expiry_date: futureDate,
          amount_microdollars: 5_000_000,
          original_baseline_microdollars_used: 0, // Wrong - should be 1_000_000
          expiration_baseline_microdollars_used: 0, // Wrong - should be 1_000_000
          description: null,
          is_free: true,
          original_transaction_id: null,
        },
      ],
    });

    expect(result.updatesForOriginalBaseline).toHaveLength(1);
    expect(result.updatesForOriginalBaseline[0].baseline).toBe(1_000_000);
    expect(result.updatesForExpirationBaseline).toHaveLength(1);
    expect(result.updatesForExpirationBaseline[0].baseline).toBe(1_000_000);
  });

  test('should handle user with no expirations', () => {
    const creditDate = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString();

    const result = computeUserBalanceUpdates({
      user: {
        id: 'test-user',
        updated_at: new Date().toISOString(),
        microdollars_used: 0,
        total_microdollars_acquired: 10_000_000,
      },
      usageRecords: [],
      creditTransactions: [
        {
          id: 'tx-1',
          created_at: creditDate,
          expiry_date: null, // No expiration
          amount_microdollars: 10_000_000,
          original_baseline_microdollars_used: 0,
          expiration_baseline_microdollars_used: null,
          description: 'Purchase',
          is_free: false,
          original_transaction_id: null,
        },
      ],
    });

    expect(result.updatesForOriginalBaseline).toHaveLength(0);
    expect(result.updatesForExpirationBaseline).toHaveLength(0);
    expect(result.accounting_error_mUsd).toBe(0);
  });

  test('should handle complex scenario with multiple expired and future expiring transactions', () => {
    // Timeline:
    // T0: Usage $100
    // T1: Grant A ($500, expired at T3)
    // T2: Grant B ($300, expired at T4)
    // T3: A expires - claimed $400 (100-500), expired $100
    // T3: Expiration record for A
    // T4: B expires - baseline shifted to 500, claimed $0, expired $300
    // T4: Expiration record for B
    // T5: Grant C ($200, expires future)
    // T6: Grant D ($150, expires future)
    // Current usage: $500

    const T0 = '2024-01-01T00:00:00Z';
    const T1 = '2024-01-02T00:00:00Z';
    const T2 = '2024-01-03T00:00:00Z';
    const T3 = '2024-01-10T00:00:00Z';
    const T4 = '2024-01-15T00:00:00Z';
    const T5 = '2024-01-20T00:00:00Z';
    const T6 = '2024-01-25T00:00:00Z';
    const future1 = '2024-06-01T00:00:00Z';
    const future2 = '2024-07-01T00:00:00Z';

    const result = computeUserBalanceUpdates({
      user: {
        id: 'test-user',
        updated_at: new Date().toISOString(),
        microdollars_used: 500,
        total_microdollars_acquired: 750, // 500+300+200+150 - 100 - 300 = 750
      },
      usageRecords: [
        { cost: 100, created_at: T0 },
        { cost: 400, created_at: T2 },
      ],
      creditTransactions: [
        {
          id: 'grant-a',
          created_at: T1,
          expiry_date: T3,
          amount_microdollars: 500,
          original_baseline_microdollars_used: 100,
          expiration_baseline_microdollars_used: 100,
          description: 'Grant A',
          is_free: true,
          original_transaction_id: null,
        },
        {
          id: 'grant-b',
          created_at: T2,
          expiry_date: T4,
          amount_microdollars: 300,
          original_baseline_microdollars_used: 100,
          expiration_baseline_microdollars_used: 500, // Shifted due to A's expiration
          description: 'Grant B',
          is_free: true,
          original_transaction_id: null,
        },
        {
          id: 'exp-a',
          created_at: T3,
          expiry_date: null,
          amount_microdollars: -100, // Expired $100
          original_baseline_microdollars_used: 500,
          expiration_baseline_microdollars_used: null,
          description: 'Expired: Grant A',
          is_free: true,
          original_transaction_id: 'grant-a',
        },
        {
          id: 'exp-b',
          created_at: T4,
          expiry_date: null,
          amount_microdollars: -300, // Expired $300
          original_baseline_microdollars_used: 500,
          expiration_baseline_microdollars_used: null,
          description: 'Expired: Grant B',
          is_free: true,
          original_transaction_id: 'grant-b',
        },
        {
          id: 'grant-c',
          created_at: T5,
          expiry_date: future1,
          amount_microdollars: 200,
          original_baseline_microdollars_used: 500,
          expiration_baseline_microdollars_used: 500,
          description: 'Grant C',
          is_free: true,
          original_transaction_id: null,
        },
        {
          id: 'grant-d',
          created_at: T6,
          expiry_date: future2,
          amount_microdollars: 150,
          original_baseline_microdollars_used: 500,
          expiration_baseline_microdollars_used: 500,
          description: 'Grant D',
          is_free: true,
          original_transaction_id: null,
        },
      ],
    });

    // Original baselines should be correct (usage at creation time)
    // Grant A: 100 (usage before T1)
    // Grant B: 100 (usage before T2, but T0 usage is 100)
    // exp-a: 500 (usage before T3)
    // exp-b: 500 (usage before T4)
    // Grant C: 500 (usage before T5)
    // Grant D: 500 (usage before T6)
    expect(result.updatesForOriginalBaseline).toHaveLength(0);

    // Expiration baselines for future grants should account for past expirations
    // Grant C and D should have shifted baselines due to A and B's expirations
    // The lastExpirationTime is T4, so computeExpiration runs up to T4
    // At T4, both A and B have expired, shifting baselines appropriately
    expect(result.accounting_error_mUsd).toBe(0);
  });
});
