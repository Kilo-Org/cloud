import { db } from '@kilocode/web-shared/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { fetchExpiringTransactions } from '@kilocode/web-shared/lib/creditExpiration';
import { recomputeNextCreditExpiration } from './recomputeNextCreditExpiration';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

describe('fetchExpiringTransactions', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(credit_transactions);
  });

  test('returns transactions with expiry dates', async () => {
    const user = await insertTestUser();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 5_000_000,
      is_free: true,
      credit_category: 'free_credits',
      expiry_date: futureDate,
    });

    const result = await fetchExpiringTransactions(user.id);
    expect(result).toHaveLength(1);
    expect(result[0].expiry_date).toContain(futureDate.slice(0, 10));
  });

  test.each([
    { category: 'credits_expired', matchesOwner: true, closed: true },
    { category: 'orb_credit_expired', matchesOwner: true, closed: true },
    { category: 'orb_credit_voided', matchesOwner: true, closed: true },
    { category: 'accounting_adjustment', matchesOwner: true, closed: false },
    { category: null, matchesOwner: true, closed: false },
    { category: 'credits_expired', matchesOwner: false, closed: false },
  ])(
    'matches expiration owner and category ($category, owner match: $matchesOwner)',
    async ({ category, matchesOwner, closed }) => {
      const user = await insertTestUser();
      const closureOwner = matchesOwner ? user : await insertTestUser();
      const pastDate = new Date(Date.now() - 86400000).toISOString();

      const [original] = await db
        .insert(credit_transactions)
        .values({
          kilo_user_id: user.id,
          amount_microdollars: 5_000_000,
          is_free: true,
          credit_category: 'free_credits',
          expiry_date: pastDate,
        })
        .returning();

      // Add expiration record
      await db.insert(credit_transactions).values({
        kilo_user_id: closureOwner.id,
        amount_microdollars: -5_000_000,
        is_free: true,
        credit_category: category,
        original_transaction_id: original.id,
      });

      const result = await fetchExpiringTransactions(user.id);
      expect(result.map(transaction => transaction.id)).toEqual(closed ? [] : [original.id]);
    }
  );
});

describe('recomputeNextCreditExpiration', () => {
  beforeEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(credit_transactions);
  });

  test('sets earliest expiry date', async () => {
    const user = await insertTestUser();
    const date1 = new Date(Date.now() + 86400000).toISOString();
    const date2 = new Date(Date.now() + 172800000).toISOString();

    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        amount_microdollars: 5_000_000,
        is_free: true,
        credit_category: 'free_credits',
        expiry_date: date2,
      },
      {
        kilo_user_id: user.id,
        amount_microdollars: 3_000_000,
        is_free: true,
        credit_category: 'free_credits',
        expiry_date: date1,
      },
    ]);

    const result = await recomputeNextCreditExpiration(user.id);
    expect(result.newValue).toContain(date1.slice(0, 10));
    expect(result.updated).toBe(true);
  });

  test('dryRun does not update', async () => {
    const user = await insertTestUser();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 5_000_000,
      is_free: true,
      credit_category: 'free_credits',
      expiry_date: futureDate,
    });

    const result = await recomputeNextCreditExpiration(user.id, { dryRun: true });
    expect(result.newValue).toContain(futureDate.slice(0, 10));
    expect(result.updated).toBe(false);
  });

  test('clears expiration when no expiring transactions', async () => {
    const user = await insertTestUser();
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    await db
      .update(kilocode_users)
      .set({ next_credit_expiration_at: futureDate })
      .where(eq(kilocode_users.id, user.id));

    const result = await recomputeNextCreditExpiration(user.id);
    expect(result.oldValue).toContain(futureDate.slice(0, 10));
    expect(result.newValue).toBeNull();
    expect(result.updated).toBe(true);
  });
});
