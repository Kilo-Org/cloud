import type { credit_transactions } from '@/db/schema';
import { credit_transactions as creditTransactionsTable, kilocode_users } from '@/db/schema';
import { computeExpiration, processLocalExpirations } from './creditExpiration';
import { db } from '@/lib/drizzle';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const makeTransaction = (
  id: string,
  expiryDate: string,
  baseline: number,
  amount: number,
  description = 'Test credits'
) => ({
  id,
  orb_credit_block_id: `orb_${id}`,
  amount_microdollars: amount,
  expiration_baseline_microdollars_used: baseline,
  expiry_date: expiryDate,
  description,
  is_free: true,
});

const userMicrodollarsUsed = (microdollars_used: number) => ({
  id: 'ignored',
  microdollars_used,
});

type Transaction = ReturnType<typeof makeTransaction>;
type NewTransaction = typeof credit_transactions.$inferInsert;

const applyExpirationResult = (
  transactions: Transaction[],
  result: ReturnType<typeof computeExpiration>
): Transaction[] => {
  const expiredIds = new Set(result.newTransactions.map(t => t.original_transaction_id));
  return transactions
    .filter(t => !expiredIds.has(t.id))
    .map(t => ({
      ...t,
      expiration_baseline_microdollars_used:
        result.newBaselines.get(t.id) ?? t.expiration_baseline_microdollars_used,
    }));
};

describe('computeExpiration', () => {
  const now = new Date('2024-01-15');

  it('returns empty result when no transactions are expired', () => {
    const transactions = [makeTransaction('t1', '2024-02-01', 0, 1000)];
    const user = userMicrodollarsUsed(500);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions).toHaveLength(0);
    expect(result.newBaselines.size).toBe(0);
  });

  it('expires full amount when user has no usage', () => {
    const transactions = [makeTransaction('t1', '2024-01-10', 0, 1000)];
    const user = userMicrodollarsUsed(0);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(-1000);
    expect(result.newBaselines.size).toBe(0);
  });

  it('expires nothing when user has used all credits', () => {
    const transactions = [makeTransaction('t1', '2024-01-10', 0, 1000)];
    const user = userMicrodollarsUsed(1500);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(0);
    expect(result.newBaselines.size).toBe(0);
  });

  it('handles partial expiry correctly', () => {
    const transactions = [makeTransaction('t1', '2024-01-10', 0, 1000)];
    const user = userMicrodollarsUsed(400);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(-600);
  });

  it('sets correct metadata on new transaction', () => {
    const transactions = [makeTransaction('t1', '2024-01-10', 0, 1000, 'Promo credits')];
    const user = userMicrodollarsUsed(0);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions[0].kilo_user_id).toBe('ignored');
    expect(result.newTransactions[0].credit_category).toBe('credits_expired');
    expect(result.newTransactions[0].is_free).toBe(true);
    expect(result.newTransactions[0].created_at).toBe('2024-01-10');
    expect(result.newTransactions[0].description).toBe('Expired: Promo credits');
  });

  it('expires all expired transactions in order', () => {
    const transactions = [
      makeTransaction('t2', '2024-01-12', 300, 2000, 'Later credits'),
      makeTransaction('t1', '2024-01-10', 0, 1000, 'Earlier credits'),
    ];
    const user = userMicrodollarsUsed(500);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-2500);
    expect(result.newTransactions).toHaveLength(2);
    expect(result.newTransactions[0].original_transaction_id).toBe('t1');
    expect(result.newTransactions[0].description).toBe('Expired: Earlier credits');
    expect(result.newTransactions[0].amount_microdollars).toBe(-500);
    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].description).toBe('Expired: Later credits');
    expect(result.newTransactions[1].amount_microdollars).toBe(-2000);
    expect(result.newBaselines.get('t2')).toBe(500);
  });

  it('expires all expired transactions in order, even if some are not expired', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-10', 0, 1000, 'Earlier credits'),
      makeTransaction('t2', '2024-01-12', 100, 2000, 'Later credits'),
      makeTransaction('t3', '2024-01-14', 300, 6000, 'Even later credits'),
      makeTransaction('t4', '2024-01-24', 500, 3000, 'Nonexpired credits'),
    ];
    const user = userMicrodollarsUsed(4000);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-5000);

    expect(result.newTransactions).toHaveLength(3);
    expect(result.newTransactions[0].original_transaction_id).toBe('t1');
    expect(result.newTransactions[0].amount_microdollars).toBe(0);

    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].amount_microdollars).toBe(0);

    expect(result.newTransactions[2].original_transaction_id).toBe('t3');
    expect(result.newTransactions[2].amount_microdollars).toBe(-5000);

    expect(result.newBaselines.has('t1')).toBe(false);
    expect(result.newBaselines.get('t2')).toBe(1000);
    expect(result.newBaselines.get('t3')).toBe(3000);
    expect(result.newBaselines.get('t4')).toBe(4000);
  });

  it("when expiring multiple transactions, it correctly uses the transaction's baseline", () => {
    const transactions = [
      makeTransaction('t1', '2024-01-10', 14000, 1000, 'Earlier credits'),
      makeTransaction('t2', '2024-01-12', 15500, 2000, 'Later credits'),
    ];
    const user = userMicrodollarsUsed(16000);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-1500);

    expect(result.newTransactions).toHaveLength(2);
    expect(result.newTransactions[0].original_transaction_id).toBe('t1');
    expect(result.newTransactions[0].description).toBe('Expired: Earlier credits');
    expect(result.newTransactions[0].amount_microdollars).toBe(0);

    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].amount_microdollars).toBe(-1500);

    expect(result.newBaselines.has('t1')).toBe(false);
    expect(result.newBaselines.has('t2')).toBe(false);
  });

  it('shifts baselines for other transactions correctly when partially expiring', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-10', 0, 1000),
      makeTransaction('t2', '2024-01-20', 200, 2000),
      makeTransaction('t3', '2024-02-01', 300, 500),
    ];
    const user = userMicrodollarsUsed(700);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newBaselines.has('t1')).toBe(false);
    expect(result.newBaselines.get('t2')).toBe(700);
    expect(result.newBaselines.get('t3')).toBe(700);
  });

  it('shifts baselines for other transactions correctly when fully expiring', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-10', 0, 1000),
      makeTransaction('t2', '2024-01-20', 600, 2000),
      makeTransaction('t3', '2024-02-01', 1200, 500),
    ];
    const user = userMicrodollarsUsed(1700);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newBaselines.has('t1')).toBe(false);
    expect(result.newBaselines.get('t2')).toBe(1000);
    expect(result.newBaselines.has('t3')).toBe(false);
  });

  it('deals with out-of-order expiry well', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-14', 1000, 1000),
      makeTransaction('t2', '2024-01-10', 1200, 2000), //higher baseline, so acquired later but expires earlier.
      makeTransaction('t3', '2024-02-01', 1300, 500),
    ];
    const user = userMicrodollarsUsed(1700);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-2300);

    expect(result.newTransactions[0].original_transaction_id).toBe('t2');
    expect(result.newTransactions[0].amount_microdollars).toBe(-1500);
    expect(result.newBaselines.has('t2')).toBe(false);

    expect(result.newBaselines.get('t1')).toBe(1500);
    expect(result.newTransactions[1].original_transaction_id).toBe('t1');
    expect(result.newTransactions[1].amount_microdollars).toBe(-800);

    expect(result.newBaselines.get('t3')).toBe(1700);
  });

  it('deals with out-of-order expiry well, even if unexpired credits have the lowest baseline', () => {
    const transactions = [
      makeTransaction('t1', '2024-02-01', 700, 500),
      makeTransaction('t2', '2024-01-14', 1000, 1000),
      makeTransaction('t3', '2024-01-10', 1200, 2000), //higher baseline, so acquired later but expires earlier.
    ];
    const user = userMicrodollarsUsed(1700);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-2300);

    expect(result.newTransactions[0].original_transaction_id).toBe('t3');
    expect(result.newTransactions[0].amount_microdollars).toBe(-1500);
    expect(result.newBaselines.has('t3')).toBe(false);

    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].amount_microdollars).toBe(-800);
    expect(result.newBaselines.get('t2')).toBe(1500);

    expect(result.newBaselines.get('t1')).toBe(1400);
  });

  it('deals with out-of-order expiry well, 2', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-14', 1000, 1000),
      makeTransaction('t2', '2024-01-12', 1100, 2000),
      makeTransaction('t3', '2024-01-10', 1200, 2000), //higher baseline, so acquired later but expires earlier.
      makeTransaction('t4', '2024-02-01', 1300, 500),
    ];
    const user = userMicrodollarsUsed(1700);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-4300);

    expect(result.newTransactions[0].original_transaction_id).toBe('t3');
    expect(result.newTransactions[0].amount_microdollars).toBe(-1500);
    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].amount_microdollars).toBe(-1900);
    expect(result.newTransactions[2].original_transaction_id).toBe('t1');
    expect(result.newTransactions[2].amount_microdollars).toBe(-900);

    expect(result.newBaselines.has('t3')).toBe(false);
    expect(result.newBaselines.get('t2')).toBe(1600);
    expect(result.newBaselines.get('t1')).toBe(1600);
    expect(result.newBaselines.get('t4')).toBe(1700);
  });

  it('deals with out-of-order expiry well, 3', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-14', 1000, 1000),
      makeTransaction('t2', '2024-01-12', 1400, 2000),
      makeTransaction('t3', '2024-01-10', 1200, 2000), //higher baseline, so acquired later but expires earlier.
      makeTransaction('t4', '2024-02-01', 1300, 500),
    ];
    const user = userMicrodollarsUsed(1700);

    const result = computeExpiration(transactions, user, now, user.id);
    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-4300);

    expect(result.newTransactions[0].original_transaction_id).toBe('t3');
    expect(result.newTransactions[0].amount_microdollars).toBe(-1500);
    expect(result.newTransactions[1].original_transaction_id).toBe('t2');
    expect(result.newTransactions[1].amount_microdollars).toBe(-2000);
    expect(result.newTransactions[2].original_transaction_id).toBe('t1');
    expect(result.newTransactions[2].amount_microdollars).toBe(-800);

    expect(result.newBaselines.has('t3')).toBe(false);
    expect(result.newBaselines.get('t2')).toBe(1700);
    expect(result.newBaselines.get('t1')).toBe(1500);
    expect(result.newBaselines.get('t4')).toBe(1700);
  });

  it('correctly handles breathing room when later-expiring transaction has lower baseline (2 transactions)', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-14', 4, 10),
      makeTransaction('t2', '2024-01-10', 10, 5), // expires first!
    ];
    const user = userMicrodollarsUsed(15);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions[0].original_transaction_id).toBe('t2');
    expect(result.newTransactions[0].amount_microdollars).toBe(0);

    expect(result.newBaselines.get('t1')).toBe(9);
    expect(result.newTransactions[1].original_transaction_id).toBe('t1');
    expect(result.newTransactions[1].amount_microdollars).toBe(-4);
  });

  it('correctly handles breathing room when later-expiring transaction has lower baseline (3 transactions)', () => {
    const transactions = [
      makeTransaction('t1', '2024-01-12', 2, 3),
      makeTransaction('t2', '2024-01-14', 4, 10),
      makeTransaction('t3', '2024-01-10', 10, 5), // expires first!
    ];
    const user = userMicrodollarsUsed(15);

    const result = computeExpiration(transactions, user, now, user.id);

    expect(result.newTransactions.reduce((sum, t) => sum + t.amount_microdollars, 0)).toBe(-5);
    expect(result.newTransactions[0].original_transaction_id).toBe('t3');
    expect(result.newTransactions[0].amount_microdollars).toBe(0);

    expect(result.newTransactions[1].original_transaction_id).toBe('t1');
    expect(result.newTransactions[1].amount_microdollars).toBe(0);
    expect(result.newBaselines.get('t1')).toBe(7);

    expect(result.newBaselines.get('t2')).toBe(10);
    expect(result.newTransactions[2].original_transaction_id).toBe('t2');
    expect(result.newTransactions[2].amount_microdollars).toBe(-5);
  });

  const describeIncrementalExpirationScenario = (scenario: {
    name: string;
    transactions: Transaction[];
    microdollarsUsed: number;
    finalDate: Date;
    expectedResults: [string, number][];
  }) => {
    describe(`incremental expiration: ${scenario.name}`, () => {
      const user = userMicrodollarsUsed(scenario.microdollarsUsed);
      const expiryDates = scenario.transactions
        .map(t => new Date(t.expiry_date))
        .filter(d => d < scenario.finalDate)
        .sort((a, b) => a.getTime() - b.getTime());

      const expectTransactionsMatch = (actual: NewTransaction[], expected: [string, number][]) => {
        expect(actual).toHaveLength(expected.length);
        for (let i = 0; i < expected.length; i++) {
          expect(actual[i].original_transaction_id).toBe(expected[i][0]);
          expect(actual[i].amount_microdollars).toBe(expected[i][1]);
        }
      };

      const runIncrementalExpiration = (initialTransactions: Transaction[], dates: Date[]) => {
        let currentTransactions = initialTransactions;
        const collectedTransactions: NewTransaction[] = [];
        for (const date of dates) {
          const result = computeExpiration(currentTransactions, user, date, user.id);
          collectedTransactions.push(...result.newTransactions);
          currentTransactions = applyExpirationResult(currentTransactions, result);
        }
        return collectedTransactions;
      };

      it('incremental day-by-day expiration produces expected results', () => {
        const collected = runIncrementalExpiration(scenario.transactions, expiryDates);
        expectTransactionsMatch(collected, scenario.expectedResults);
      });

      it('immediate mode produces same results as incremental', () => {
        const immediateResult = computeExpiration(
          scenario.transactions,
          user,
          scenario.finalDate,
          user.id
        );
        expectTransactionsMatch(immediateResult.newTransactions, scenario.expectedResults);
      });

      it.each(expiryDates)('split at %s produces same result as full incremental', splitDate => {
        const collected = runIncrementalExpiration(scenario.transactions, [
          splitDate,
          scenario.finalDate,
        ]);
        expectTransactionsMatch(collected, scenario.expectedResults);
      });
    });
  };

  describeIncrementalExpirationScenario({
    name: 'overlapping credits with different expiry dates',
    transactions: [
      makeTransaction('t1', '2024-01-02', 1000, 1000),
      makeTransaction('t2', '2024-01-10', 10500, 1000), // expires first!
      makeTransaction('t3', '2024-01-11', 10300, 1000),
      // t2 and t3 overlap in range 10500-11300
    ],
    microdollarsUsed: 10900,
    finalDate: new Date('2024-01-15'),
    expectedResults: [
      ['t1', 0],
      ['t2', -600],
      ['t3', -800],
    ],
  });
  describeIncrementalExpirationScenario({
    name: 'three overlapping credits expiring on different dates',
    transactions: [
      makeTransaction('t1', '2024-01-10', 100, 100),
      makeTransaction('t2', '2024-01-11', 80, 100),
      makeTransaction('t3', '2024-01-12', 50, 100),
      // all three overlap
    ],
    microdollarsUsed: 150,
    finalDate: new Date('2024-01-15'),
    expectedResults: [
      ['t1', -50],
      ['t2', -80],
      ['t3', -70],
    ],
  });

  describeIncrementalExpirationScenario({
    name: 'overlapping later credits reclaim usage after earlier disjoint credits expired',
    transactions: [
      makeTransaction('t1', '2024-01-01', 0, 100),
      makeTransaction('t2', '2024-01-03', 220, 80),
      makeTransaction('t3', '2024-01-04', 200, 80),
    ],
    microdollarsUsed: 260,
    finalDate: new Date('2024-01-10'),
    expectedResults: [
      ['t1', 0],
      ['t2', -40],
      ['t3', -60],
    ],
  });

  describeIncrementalExpirationScenario({
    name: 'long term overlap',
    transactions: [
      makeTransaction('t1', '2024-01-14', 0, 1000),
      makeTransaction('t2', '2024-01-01', 100, 100),
      makeTransaction('t3', '2024-01-02', 300, 100),
      makeTransaction('t4', '2024-01-03', 500, 100),
      makeTransaction('t5', '2024-01-04', 700, 100),
    ],
    microdollarsUsed: 1000,
    finalDate: new Date('2024-01-15'),
    expectedResults: [
      ['t2', 0],
      ['t3', 0],
      ['t4', 0],
      ['t5', 0],
      ['t1', -400],
    ],
  });
});

describe('processLocalExpirations', () => {
  const insertMigratedTestUser = async (
    userData: Partial<typeof kilocode_users.$inferInsert> = {}
  ) => {
    const user = defineTestUser(userData);
    const [insertedUser] = await db.insert(kilocode_users).values(user).returning();
    // Note: NOT inserting into legacy_orb_credit_expiration_users - this is a migrated user
    return insertedUser;
  };

  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(creditTransactionsTable);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(kilocode_users);
  });

  it('processes expired transactions and creates expiration entries', async () => {
    const user = await insertMigratedTestUser({
      microdollars_used: 500,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
    });

    // Insert a transaction that should expire
    const initialId = randomUUID();
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: user.id,
      amount_microdollars: 1000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      id: initialId,
      description: 'Test credits',
    });

    const now = new Date('2024-01-15');
    const result = await processLocalExpirations(user, now);

    expect(result).not.toBeNull();

    // Check that expiration transaction was created
    const expirationTxns = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));

    expect(expirationTxns).toHaveLength(1);
    expect(expirationTxns[0].amount_microdollars).toBe(-500); // 1000 - 500 used = 500 expired
    expect(expirationTxns[0].original_transaction_id).toBe(initialId);
  });

  it('is idempotent - calling twice does not create duplicate expirations', async () => {
    const user = await insertMigratedTestUser({
      microdollars_used: 0,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
    });

    await db.insert(creditTransactionsTable).values({
      kilo_user_id: user.id,
      amount_microdollars: 1000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Test credits',
    });

    const now = new Date('2024-01-15');

    // First call
    await processLocalExpirations(user, now);

    // Get updated next_credit_expiration_at
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
      columns: { next_credit_expiration_at: true },
    });

    // Second call with updated user
    const userForSecondCall = {
      ...user,
      next_credit_expiration_at: updatedUser?.next_credit_expiration_at ?? null,
    };
    await processLocalExpirations(userForSecondCall, now);

    // Should still only have one expiration transaction
    const expirationTxns = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));

    expect(expirationTxns).toHaveLength(1);
  });

  it('returns null when no expirations to process', async () => {
    const user = await insertMigratedTestUser({
      microdollars_used: 0,
      next_credit_expiration_at: '2024-02-01T00:00:00Z', // Future date
    });

    await db.insert(creditTransactionsTable).values({
      kilo_user_id: user.id,
      amount_microdollars: 1000,
      is_free: true,
      expiry_date: '2024-02-01T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Test credits',
    });

    const now = new Date('2024-01-15');
    const result = await processLocalExpirations(user, now);

    expect(result).toBeNull();
  });

  it('handles concurrent execution - one succeeds, other returns null', async () => {
    const user = await insertMigratedTestUser({
      microdollars_used: 0,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
    });

    await db.insert(creditTransactionsTable).values({
      kilo_user_id: user.id,
      amount_microdollars: 1000,
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Test credits',
    });

    const now = new Date('2024-01-15');

    // Launch two concurrent processes
    const [result1, result2] = await Promise.all([
      processLocalExpirations(user, now),
      processLocalExpirations(user, now),
    ]);

    // Exactly one should succeed, one should return null (optimistic lock failed)
    const results = [result1, result2];
    const successes = results.filter(r => r !== null);
    const nulls = results.filter(r => r === null);

    expect(successes).toHaveLength(1);
    expect(nulls).toHaveLength(1);

    // Verify: Only ONE expiration transaction created (no duplicates)
    const expirations = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));

    expect(expirations).toHaveLength(1);
    expect(expirations[0].amount_microdollars).toBe(-1000);
  });

  it('grantCreditForCategory sets next_credit_expiration_at correctly', async () => {
    const { grantCreditForCategory } = await import('./promotionalCredits');

    // Create user with no expiration date set
    const user = await insertMigratedTestUser({
      microdollars_used: 0,
      total_microdollars_acquired: 0,
      next_credit_expiration_at: null,
    });

    // Grant credits with expiry - should set next_credit_expiration_at
    const expiry1 = new Date('2024-02-15T00:00:00Z');
    await grantCreditForCategory(user, {
      credit_category: 'custom',
      counts_as_selfservice: false,
      amount_usd: 5,
      description: 'First credits',
      credit_expiry_date: expiry1,
    });

    const userAfter1 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(new Date(userAfter1!.next_credit_expiration_at!).getTime()).toBe(expiry1.getTime());

    // Grant credits with earlier expiry - should update to earlier date
    const expiry2 = new Date('2024-01-10T00:00:00Z');
    await grantCreditForCategory(userAfter1!, {
      credit_category: 'custom',
      counts_as_selfservice: false,
      amount_usd: 3,
      description: 'Earlier credits',
      credit_expiry_date: expiry2,
    });

    const userAfter2 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(new Date(userAfter2!.next_credit_expiration_at!).getTime()).toBe(expiry2.getTime());

    // Grant credits with later expiry - should NOT update (keep earlier date)
    const expiry3 = new Date('2024-03-01T00:00:00Z');
    await grantCreditForCategory(userAfter2!, {
      credit_category: 'custom',
      counts_as_selfservice: false,
      amount_usd: 2,
      description: 'Later credits',
      credit_expiry_date: expiry3,
    });

    const userAfter3 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(new Date(userAfter3!.next_credit_expiration_at!).getTime()).toBe(expiry2.getTime());
  });

  it('tracks original_baseline_microdollars_used immutably through full lifecycle', async () => {
    // Scenario:
    // 1. Create user with non-zero usage ($2 already spent)
    // 2. Acquire credits A ($10, expires Jan 10) via grantCreditForCategory - original_baseline = 2M
    // 3. User spends $3 more (microdollars_used = 5_000_000)
    // 4. Acquire credits B ($5, expires Jan 20) via grantCreditForCategory - original_baseline = 5M
    // 5. User spends $2 more (microdollars_used = 7_000_000)
    // 6. Jan 15: Expire A - should shift B's expiration_baseline but NOT original_baseline
    // 7. User spends $1 more (microdollars_used = 8_000_000)
    // 8. Jan 25: Expire B - verify original_baseline unchanged

    // Import grantCreditForCategory
    const { grantCreditForCategory } = await import('./promotionalCredits');

    // Step 1: Create user with non-zero usage
    const user = await insertMigratedTestUser({
      microdollars_used: 2_000_000, // Start with $2 already spent
    });

    // Step 2: Acquire credits A ($10, expires Jan 10) using production function
    const expiryA = new Date('2024-01-10T00:00:00Z');
    const resultA = await grantCreditForCategory(user, {
      credit_category: 'custom',
      counts_as_selfservice: false,
      amount_usd: 10,
      description: 'Credits A',
      credit_expiry_date: expiryA,
    });
    expect(resultA.success).toBe(true);

    // Verify grantCreditForCategory set next_credit_expiration_at
    const userAfterA = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(new Date(userAfterA!.next_credit_expiration_at!).getTime()).toBe(expiryA.getTime());

    // Verify A was created with correct original_baseline
    const txnA = await db.query.credit_transactions.findFirst({
      where: eq(creditTransactionsTable.description, 'Credits A'),
    });
    expect(txnA).toBeDefined();
    expect(txnA!.original_baseline_microdollars_used).toBe(2_000_000);
    expect(txnA!.expiration_baseline_microdollars_used).toBe(2_000_000);

    // Step 3: User spends $3 more (total $5)
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 5_000_000 })
      .where(eq(kilocode_users.id, user.id));

    // Refetch user for next grant
    const userAfterUsage1 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    // Step 4: Acquire credits B ($5, expires Jan 20) using production function
    const expiryB = new Date('2024-01-20T00:00:00Z');
    const resultB = await grantCreditForCategory(userAfterUsage1!, {
      credit_category: 'custom',
      counts_as_selfservice: false,
      amount_usd: 5,
      description: 'Credits B',
      credit_expiry_date: expiryB,
    });
    expect(resultB.success).toBe(true);

    // Verify B was created with correct original_baseline
    const txnB = await db.query.credit_transactions.findFirst({
      where: eq(creditTransactionsTable.description, 'Credits B'),
    });
    expect(txnB).toBeDefined();
    expect(txnB!.original_baseline_microdollars_used).toBe(5_000_000);
    expect(txnB!.expiration_baseline_microdollars_used).toBe(5_000_000);

    // Step 5: User spends $2 more (total $7)
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 7_000_000 })
      .where(eq(kilocode_users.id, user.id));

    // Step 6: Process expiration at Jan 15 (A expires)
    const userAtJan15 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    const jan15 = new Date('2024-01-15T00:00:00Z');

    await processLocalExpirations(userAtJan15!, jan15);

    // Verify: A expired, B's expiration_baseline shifted but original_baseline unchanged
    const txnsAfterFirstExpiry = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.kilo_user_id, user.id));

    const blockB = txnsAfterFirstExpiry.find(t => t.description === 'Credits B');
    expect(blockB).toBeDefined();
    // B's expiration_baseline should have shifted
    // A's range: 2M-12M, used 2M-7M = 5M usage claimed
    // B's original range: 5M-10M, overlaps with A's claimed 2M-7M by 2M (5M-7M)
    // So B's expiration_baseline shifts from 5M to 7M
    expect(blockB!.expiration_baseline_microdollars_used).toBe(7_000_000);
    // But original_baseline must remain unchanged
    expect(blockB!.original_baseline_microdollars_used).toBe(5_000_000);

    // Verify expiration transaction for A was created (linked via original_transaction_id)
    const expirationA = txnsAfterFirstExpiry.find(
      t => t.credit_category === 'credits_expired' && t.original_transaction_id === txnA!.id
    );
    expect(expirationA).toBeDefined();
    // A had $10 (range 2M-12M), user at 7M, so 5M used from A (2M-7M), 5M expired
    expect(expirationA!.amount_microdollars).toBe(-5_000_000);

    // Step 7: User spends $1 more (total $8)
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 8_000_000 })
      .where(eq(kilocode_users.id, user.id));

    // Step 8: Process expiration at Jan 25 (B expires)
    const userAtJan25 = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    // Verify next_credit_expiration_at was updated to B's expiry after A expired
    expect(new Date(userAtJan25!.next_credit_expiration_at!).getTime()).toBe(
      new Date('2024-01-20T00:00:00Z').getTime()
    );
    const jan25 = new Date('2024-01-25T00:00:00Z');
    await processLocalExpirations(userAtJan25!, jan25);

    // Final verification
    const finalTxns = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.kilo_user_id, user.id));

    // Verify B's original_baseline is still unchanged
    const finalBlockB = finalTxns.find(
      t => t.description === 'Credits B' && t.credit_category !== 'credits_expired'
    );
    expect(finalBlockB!.original_baseline_microdollars_used).toBe(5_000_000);

    // Verify expiration transaction for B was created (linked via original_transaction_id)
    const expirationB = finalTxns.find(
      t => t.credit_category === 'credits_expired' && t.original_transaction_id === txnB!.id
    );
    expect(expirationB).toBeDefined();
    // B had $5 (range 5M-10M), baseline shifted to 7M, user at 8M
    // So 1M used from B (7M-8M), 4M expired (8M-10M + the 2M that was shifted = wait, let me recalc)
    // After shift: B's range is 7M-12M (baseline 7M + amount 5M)
    // User at 8M, so 1M used from B, 4M expired
    expect(expirationB!.amount_microdollars).toBe(-4_000_000);
  });

  /**
   * Helper: refetch user from DB (needed after mutations to get latest state).
   */
  const refetchUser = async (userId: string) => {
    const user = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, userId),
    });
    return user!;
  };

  /**
   * Helper: insert a credit transaction directly into the DB.
   * Allows full control over baseline values, unlike grantCreditForCategory.
   */
  const insertCreditTransaction = async (
    userId: string,
    opts: {
      amount_usd: number;
      expiry_date: string | null;
      original_baseline_microdollars_used: number;
      expiration_baseline_microdollars_used?: number;
      description: string;
    }
  ) => {
    const id = randomUUID();
    const amount_microdollars = opts.amount_usd * 1_000_000;
    const [txn] = await db
      .insert(creditTransactionsTable)
      .values({
        id,
        kilo_user_id: userId,
        amount_microdollars,
        is_free: true,
        expiry_date: opts.expiry_date,
        expiration_baseline_microdollars_used: opts.expiration_baseline_microdollars_used,
        original_baseline_microdollars_used: opts.original_baseline_microdollars_used,
        description: opts.description,
      })
      .returning();
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${amount_microdollars}`,
      })
      .where(eq(kilocode_users.id, userId));

    return txn;
  };

  const accrueUsage = async (userId: string, amount_usd: number) => {
    await db
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${amount_usd * 1_000_000}`,
      })
      .where(eq(kilocode_users.id, userId));
  };

  it('simultaneous expiry of two credit grants with interleaved usage resets balance to zero', async () => {
    let user = await insertMigratedTestUser({});

    await insertCreditTransaction(user.id, {
      amount_usd: 20,
      expiry_date: null,
      original_baseline_microdollars_used: 0, // granted when user had $0 usage
      expiration_baseline_microdollars_used: 0,
      description: '$20 welcome credits',
    });

    await accrueUsage(user.id, 2);

    await insertCreditTransaction(user.id, {
      amount_usd: 100,
      expiry_date: '2026-01-04T00:00:00Z',
      original_baseline_microdollars_used: 2_000_000,
      expiration_baseline_microdollars_used: 2_000_000,
      description: 'Vibe eng $100',
    });
    await insertCreditTransaction(user.id, {
      amount_usd: 5,
      expiry_date: null,
      original_baseline_microdollars_used: 2_000_000,
      expiration_baseline_microdollars_used: 20_000_000,
      description: 'in-app survey $5',
    });

    await accrueUsage(user.id, 2);

    user = await refetchUser(user.id);

    const now = new Date('2026-01-05T00:00:00Z');
    await processLocalExpirations(user, now);

    user = await refetchUser(user.id);

    expect(user.total_microdollars_acquired / 1_000_000).toBe(23);
  });

  it('zero-amount expirations are created and do not affect balance', async () => {
    // Scenario: User has fully consumed credits before expiration
    // Should create a zero-amount expiration transaction and not affect balance
    const initialAcquired = 5_000_000; // $5
    const initialUsed = 3_000_000; // $3 (more than the $1 credit, so it's fully consumed)
    const user = await insertMigratedTestUser({
      microdollars_used: initialUsed,
      total_microdollars_acquired: initialAcquired,
      next_credit_expiration_at: '2024-01-10T00:00:00Z',
    });

    const initialId = randomUUID();
    // Add a credit that will expire with zero amount (fully consumed)
    await db.insert(creditTransactionsTable).values({
      kilo_user_id: user.id,
      amount_microdollars: 1_000_000, // $1
      is_free: true,
      expiry_date: '2024-01-10T00:00:00Z',
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      id: initialId,
      description: 'Fully consumed credits',
    });

    const now = new Date('2024-01-15');
    const result = await processLocalExpirations(user, now);

    expect(result).not.toBeNull();

    // Verify zero-amount expiration transaction was created
    const expirationTxns = await db
      .select()
      .from(creditTransactionsTable)
      .where(eq(creditTransactionsTable.credit_category, 'credits_expired'));

    expect(expirationTxns).toHaveLength(1);
    expect(expirationTxns[0].amount_microdollars).toBe(0); // Zero amount
    expect(expirationTxns[0].original_transaction_id).toBe(initialId);

    // Verify user balance is unchanged (zero-amount expiration)
    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });

    // Balance should still be: acquired - used = $5 - $3 = $2
    // The zero-amount expiration should not change total_microdollars_acquired
    expect(updatedUser?.total_microdollars_acquired).toBe(initialAcquired);
    expect(updatedUser?.microdollars_used).toBe(initialUsed);

    const balance =
      (updatedUser!.total_microdollars_acquired - updatedUser!.microdollars_used) / 1_000_000;
    expect(balance).toBe(2); // $2 balance
  });
});
