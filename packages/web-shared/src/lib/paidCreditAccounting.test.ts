import {
  computeCreditLotAllocations,
  computeExpiration,
  type ExpiringTransaction,
} from '@kilocode/db/credit-expiration';
import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from './drizzle';
import { processTopUp } from './credits';
import { processLocalExpirations, processOrganizationExpirationsBatch } from './creditExpiration';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { and, eq } from 'drizzle-orm';
import { createOrganization } from './organizations/organizations';

const lot = (
  id: string,
  expiry_date: string | null,
  amount = 100,
  baseline = 0
): ExpiringTransaction => ({
  id,
  expiry_date,
  amount_microdollars: amount,
  expiration_baseline_microdollars_used: baseline,
  description: id,
  is_free: false,
});

describe('paid credit lot accounting', () => {
  it('consumes earliest deadline first with deterministic ties and nonexpiring last', () => {
    const allocations = computeCreditLotAllocations(
      [
        lot('legacy', null),
        lot('b', '2027-02-01'),
        lot('later', '2027-03-01'),
        lot('a', '2027-02-01'),
      ],
      { id: 'user', microdollars_used: 150 }
    );
    expect(
      allocations.map(({ transaction, remaining_microdollars }) => [
        transaction.id,
        remaining_microdollars,
      ])
    ).toEqual([
      ['a', 0],
      ['b', 50],
      ['later', 100],
      ['legacy', 100],
    ]);
  });

  it('does not resurrect debt when a new grant first covers historical negative balance', () => {
    const result = computeExpiration(
      [lot('principal', '2027-01-01', 100, 0)],
      { id: 'user', microdollars_used: 20 },
      new Date('2027-01-01'),
      'user'
    );
    expect(result.newTransactions[0].amount_microdollars).toBe(-80);
  });

  it('does not expire retired or already normalized consumption twice', () => {
    const result = computeExpiration(
      [
        {
          ...lot('principal', '2027-01-01', 100, 40),
          consumed_microdollars: 40,
          retired_microdollars: 20,
        },
      ],
      { id: 'user', microdollars_used: 50 },
      new Date('2027-01-01'),
      'user'
    );
    expect(result.newTransactions[0].amount_microdollars).toBe(-30);
  });

  it('does not treat source-linked negative adjustments retaining a deadline as grants', () => {
    const result = computeExpiration(
      [lot('refund', '2027-01-01', -50), lot('principal', '2027-01-01', 100)],
      { id: 'user', microdollars_used: 0 },
      new Date('2027-01-01'),
      'user'
    );
    expect(result.newTransactions).toHaveLength(1);
    expect(result.newTransactions[0].amount_microdollars).toBe(-100);
  });
});

describe('paid grant persistence', () => {
  it('uses a primary locked debt-safe issuance baseline and replay-safe immutable deadline', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 20_000_000,
    });
    const payment = `paid-expiry:${crypto.randomUUID()}`;
    const options = {
      skipPostTopUpFreeStuff: true,
      paidCredit: {
        source: 'stripe' as const,
        purchasedAt: '2028-02-29T12:34:56.000Z',
        terms: 'one_year' as const,
      },
    };
    expect(
      await processTopUp(user, 10000, { type: 'stripe', stripe_payment_id: payment }, options)
    ).toBe(true);
    expect(
      await processTopUp(
        user,
        10000,
        { type: 'stripe', stripe_payment_id: payment },
        {
          ...options,
          paidCredit: { ...options.paidCredit, purchasedAt: '2030-01-01' },
        }
      )
    ).toBe(false);
    const grant = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.stripe_payment_id, payment),
    });
    if (!grant) throw new Error('Missing credit grant');
    expect(grant).toMatchObject({
      amount_microdollars: 100_000_000,
      original_baseline_microdollars_used: 20_000_000,
      expiration_baseline_microdollars_used: 0,
      paid_credit_policy: 'one_year',
      credit_source: 'stripe',
    });
    expect(new Date(grant.expiry_date ?? '').toISOString()).toBe('2029-02-28T12:34:56.000Z');
    const snapshot = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    if (!snapshot) throw new Error('Missing test user');
    await Promise.all([
      processLocalExpirations(snapshot, new Date('2029-03-01')),
      processLocalExpirations(snapshot, new Date('2029-03-01')),
    ]);
    const after = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(after?.total_microdollars_acquired).toBe(20_000_000);
    const closures = await db.query.credit_transactions.findMany({
      where: and(
        eq(credit_transactions.original_transaction_id, grant.id),
        eq(credit_transactions.credit_category, 'credits_expired')
      ),
    });
    expect(closures).toHaveLength(1);
    expect(closures[0].amount_microdollars).toBe(-80_000_000);
  });

  it.each(['apple', 'settlement'] as const)(
    'keeps %s principal out of expiration exposure',
    async source => {
      const user = await insertTestUser();
      const payment = `paid-exemption:${crypto.randomUUID()}`;
      await processTopUp(
        user,
        1000,
        { type: 'stripe', stripe_payment_id: payment },
        {
          skipPostTopUpFreeStuff: true,
          paidCredit: { source, purchasedAt: '2028-02-29', terms: 'one_year' },
        }
      );
      const grant = await db.query.credit_transactions.findFirst({
        where: eq(credit_transactions.stripe_payment_id, payment),
      });
      expect(grant?.expiry_date).toBeNull();
      expect(grant?.paid_credit_policy).toBe(source === 'apple' ? 'apple_exempt' : 'settlement');
      expect(grant?.retired_microdollars).toBe(source === 'settlement' ? 10_000_000 : 0);
    }
  );
});

describe('primary expiration snapshot safety', () => {
  it('accounts for consumption committed after the caller snapshot', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 0 });
    await processTopUp(
      user,
      10000,
      { type: 'stripe', stripe_payment_id: `expiry-race:${crypto.randomUUID()}` },
      {
        skipPostTopUpFreeStuff: true,
        paidCredit: { source: 'stripe', purchasedAt: '2030-01-01', terms: 'one_year' },
      }
    );
    const snapshot = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    if (!snapshot) throw new Error('Missing user');
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 20_000_000 })
      .where(eq(kilocode_users.id, user.id));
    expect(await processLocalExpirations(snapshot, new Date('2031-01-01'))).toEqual({
      total_microdollars_acquired: 20_000_000,
      microdollars_used: 20_000_000,
      next_credit_expiration_at: null,
    });
  });
});

describe('nonexpiring source consumption preservation', () => {
  it('does not consume Apple credits twice after an earlier lot expires', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 200, microdollars_used: 40 });
    const [expiring, apple] = await db
      .insert(credit_transactions)
      .values([
        {
          kilo_user_id: user.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: '2030-01-01',
          expiration_baseline_microdollars_used: 0,
          paid_credit_policy: 'one_year',
          credit_source: 'stripe',
        },
        {
          kilo_user_id: user.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: null,
          expiration_baseline_microdollars_used: 0,
          paid_credit_policy: 'apple_exempt',
          credit_source: 'apple',
        },
      ])
      .returning();
    await processLocalExpirations(user, new Date('2030-01-01'));
    const surviving = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, apple.id),
    });
    if (!surviving) throw new Error('Missing Apple lot');
    expect(surviving.expiration_baseline_microdollars_used).toBe(40);
    const allocations = computeCreditLotAllocations([surviving], {
      id: user.id,
      microdollars_used: 40,
    });
    expect(allocations[0].remaining_microdollars).toBe(100);
    const closure = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.original_transaction_id, expiring.id),
    });
    expect(closure?.amount_microdollars).toBe(-60);
  });
});

describe('organization batch source preservation', () => {
  it('propagates expiring-lot usage into nonexpiring Apple baselines', async () => {
    const owner = await insertTestUser();
    const organization = await createOrganization(`expiry-cohort:${crypto.randomUUID()}`, owner.id);
    const snapshot = {
      id: organization.id,
      microdollars_used: 40,
      total_microdollars_acquired: 200,
      next_credit_expiration_at: '2030-01-01T00:00:00.000Z',
    };
    await db
      .update(organizations)
      .set({ ...snapshot, microdollars_balance: 160 })
      .where(eq(organizations.id, organization.id));
    const [, apple] = await db
      .insert(credit_transactions)
      .values([
        {
          kilo_user_id: owner.id,
          organization_id: organization.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: '2030-01-01',
          expiration_baseline_microdollars_used: 0,
          paid_credit_policy: 'one_year',
          credit_source: 'stripe',
        },
        {
          kilo_user_id: owner.id,
          organization_id: organization.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: null,
          expiration_baseline_microdollars_used: 0,
          paid_credit_policy: 'apple_exempt',
          credit_source: 'apple',
        },
      ])
      .returning();
    const states = await processOrganizationExpirationsBatch([snapshot], new Date('2030-01-01'));
    expect(states.get(organization.id)?.total_microdollars_acquired).toBe(140);
    const preserved = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, apple.id),
    });
    expect(preserved?.expiration_baseline_microdollars_used).toBe(40);
  });
});
