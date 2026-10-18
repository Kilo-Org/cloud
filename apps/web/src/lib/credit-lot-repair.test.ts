import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  credit_transactions,
  kilocode_users,
  microdollar_usage,
  organizations,
} from '@kilocode/db/schema';
import {
  computeCreditLotAllocations,
  computeExpiration,
  reconcileCreditExpirationsInTransaction,
} from '@kilocode/db/credit-expiration';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { retireCreditBalance } from '@kilocode/web-shared/lib/creditAdjustments';
import { computeUserBalanceUpdates, recomputeUserBalances } from './user/recompute-balances';
import { recomputeOrganizationBalances } from './recomputeOrganizationBalances';

describe('credit lot balance repair', () => {
  it.each(
    (['user', 'organization'] as const).flatMap(type =>
      [-20, 0, 20].flatMap(drift =>
        [null, '2031-01-01T00:00:00.000Z'].map(laterExpiry => ({ type, drift, laterExpiry }))
      )
    )
  )(
    'preserves normalized allocation for $type with usage drift $drift and later expiry $laterExpiry',
    async ({ type, drift, laterExpiry }) => {
      const user = await insertTestUser();
      const organization =
        type === 'organization' ? await createOrganization('Lot repair', user.id) : null;
      const id = organization?.id ?? user.id;
      const owner = { type, id };
      if (organization) {
        await db
          .update(organizations)
          .set({
            total_microdollars_acquired: 200,
            microdollars_used: 80,
            microdollars_balance: 120,
          })
          .where(eq(organizations.id, id));
      } else {
        await db
          .update(kilocode_users)
          .set({ total_microdollars_acquired: 200, microdollars_used: 80 })
          .where(eq(kilocode_users.id, id));
      }
      await db.insert(credit_transactions).values(
        ['2030-01-01T00:00:00.000Z', laterExpiry].map(expiry => ({
          kilo_user_id: user.id,
          organization_id: organization?.id ?? null,
          amount_microdollars: 100,
          is_free: true,
          expiry_date: expiry,
          original_baseline_microdollars_used: 0,
          expiration_baseline_microdollars_used: 0,
          created_at: '2025-01-01T00:00:00.000Z',
        }))
      );
      await db.insert(microdollar_usage).values({
        kilo_user_id: user.id,
        organization_id: organization?.id ?? null,
        cost: 80 + drift,
        input_tokens: 1,
        output_tokens: 1,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      });
      await db.transaction(tx =>
        retireCreditBalance(tx, {
          owner,
          actorId: user.id,
          amountMicrodollars: 0,
          creditCategory: 'organization_custom',
          description: 'Normalize existing credit allocation',
          now: new Date('2026-11-01'),
        })
      );
      const result = organization
        ? await recomputeOrganizationBalances({ organizationId: id })
        : await recomputeUserBalances({ userId: id });
      expect(result.success).toBe(true);
      const table = organization ? organizations : kilocode_users;
      const [state] = await db
        .select({ used: table.microdollars_used, acquired: table.total_microdollars_acquired })
        .from(table)
        .where(eq(table.id, id));
      expect(state).toEqual({ used: 80 + drift, acquired: 200 + drift });
      const lots = await db
        .select()
        .from(credit_transactions)
        .where(
          and(
            organization
              ? eq(credit_transactions.organization_id, id)
              : eq(credit_transactions.kilo_user_id, id),
            gt(credit_transactions.amount_microdollars, 0),
            isNull(credit_transactions.credit_category)
          )
        );
      const allocations = computeCreditLotAllocations(lots, { id, microdollars_used: state.used });
      expect(allocations.map(lot => lot.remaining_microdollars)).toEqual([20, 100]);
      const expired = await db.transaction(tx =>
        reconcileCreditExpirationsInTransaction(owner, tx, new Date('2032-01-01'))
      );
      expect(expired.total_microdollars_acquired - expired.microdollars_used).toBe(
        laterExpiry ? 0 : 100
      );
    }
  );
});

describe('unmaterialized credit lot repair', () => {
  it.each(
    (['user', 'organization'] as const).flatMap(type => [-20, 20].map(drift => ({ type, drift })))
  )(
    'preserves new and nonexpiring lot exposure for $type with usage drift $drift',
    async ({ type, drift }) => {
      const user = await insertTestUser();
      const organization =
        type === 'organization' ? await createOrganization('Fresh lot repair', user.id) : null;
      const id = organization?.id ?? user.id;
      const table = organization ? organizations : kilocode_users;
      if (organization) {
        await db
          .update(organizations)
          .set({
            total_microdollars_acquired: 180,
            microdollars_used: 80,
            microdollars_balance: 100,
          })
          .where(eq(organizations.id, id));
      } else {
        await db
          .update(kilocode_users)
          .set({ total_microdollars_acquired: 180, microdollars_used: 80 })
          .where(eq(kilocode_users.id, id));
      }
      await db.insert(credit_transactions).values([
        {
          kilo_user_id: user.id,
          organization_id: organization?.id ?? null,
          amount_microdollars: 80,
          is_free: false,
          expiration_baseline_microdollars_used: 0,
          original_baseline_microdollars_used: 0,
          created_at: '2025-01-01',
        },
        {
          kilo_user_id: user.id,
          organization_id: organization?.id ?? null,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: '2030-01-01',
          expiration_baseline_microdollars_used: 80,
          original_baseline_microdollars_used: 80,
          credit_source: 'stripe',
          paid_credit_policy: 'one_year',
          created_at: '2026-01-02',
        },
      ]);
      await db
        .insert(microdollar_usage)
        .values({
          kilo_user_id: user.id,
          organization_id: organization?.id ?? null,
          cost: 80 + drift,
          input_tokens: 1,
          output_tokens: 1,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: '2026-01-01',
        });
      for (let replay = 0; replay < 2; replay++) {
        const result = organization
          ? await recomputeOrganizationBalances({ organizationId: id })
          : await recomputeUserBalances({ userId: id });
        expect(result.success).toBe(true);
        const [state] = await db
          .select({ used: table.microdollars_used, acquired: table.total_microdollars_acquired })
          .from(table)
          .where(eq(table.id, id));
        expect(state.acquired - state.used).toBe(100);
        const lots = await db
          .select()
          .from(credit_transactions)
          .where(
            and(
              organization
                ? eq(credit_transactions.organization_id, id)
                : eq(credit_transactions.kilo_user_id, id),
              gt(credit_transactions.amount_microdollars, 0)
            )
          );
        expect(
          computeCreditLotAllocations(lots, { id, microdollars_used: state.used }).reduce(
            (sum, lot) => sum + lot.remaining_microdollars,
            0
          )
        ).toBe(100);
      }
      const expired = await db.transaction(tx =>
        reconcileCreditExpirationsInTransaction({ type, id }, tx, new Date('2032-01-01'))
      );
      expect(expired.total_microdollars_acquired - expired.microdollars_used).toBe(0);
    }
  );
});

describe('legacy expiration replay', () => {
  const defaults = {
    description: null,
    is_free: true,
    original_transaction_id: null,
    consumed_microdollars: 0,
    retired_microdollars: 0,
    credit_source: null,
    credit_category: null,
    paid_credit_policy: null,
    original_baseline_microdollars_used: 0,
  };

  it('replays closed known-source lots in the corrected usage coordinate', () => {
    const legacy = {
      ...defaults,
      id: crypto.randomUUID(),
      amount_microdollars: 100,
      created_at: '2029-01-03',
      expiry_date: '2032-01-01',
      expiration_baseline_microdollars_used: 40,
    };
    const earlier = {
      ...defaults,
      id: crypto.randomUUID(),
      amount_microdollars: 50,
      created_at: '2029-01-02',
      expiry_date: '2030-01-01',
      expiration_baseline_microdollars_used: 40,
      original_baseline_microdollars_used: 40,
      credit_source: 'promotion',
    };
    const result = computeUserBalanceUpdates({
      user: defineTestUser({ microdollars_used: 80, total_microdollars_acquired: 140 }),
      usageRecords: [
        { cost: 40, created_at: '2029-01-01' },
        { cost: 50, created_at: '2029-02-01' },
      ],
      creditTransactions: [
        earlier,
        legacy,
        {
          ...defaults,
          id: crypto.randomUUID(),
          amount_microdollars: -10,
          created_at: '2030-01-01',
          expiry_date: null,
          expiration_baseline_microdollars_used: null,
          original_transaction_id: earlier.id,
        },
      ],
    });
    const baseline =
      result.updatesForExpirationBaseline.find(update => update.id === legacy.id)?.baseline ??
      legacy.expiration_baseline_microdollars_used;
    const expiry = computeExpiration(
      [{ ...legacy, expiration_baseline_microdollars_used: baseline }],
      { id: result.user.id, microdollars_used: result.user_update.microdollars_used },
      new Date('2033-01-01'),
      result.user.id
    );
    expect(expiry.newTransactions[0].amount_microdollars).toBe(-90);
  });

  it.each(['settlement', 'accounting_adjustment'])(
    'does not let %s bookkeeping disable legacy repair',
    kind => {
      const legacy = {
        ...defaults,
        id: crypto.randomUUID(),
        amount_microdollars: 100,
        created_at: '2029-01-01',
        expiry_date: '2032-01-01',
        expiration_baseline_microdollars_used: 80,
      };
      const result = computeUserBalanceUpdates({
        user: defineTestUser({ microdollars_used: 40, total_microdollars_acquired: 100 }),
        usageRecords: [{ cost: 40, created_at: '2029-02-01' }],
        creditTransactions: [
          legacy,
          {
            ...defaults,
            id: crypto.randomUUID(),
            amount_microdollars: 50,
            created_at: '2029-03-01',
            expiry_date: null,
            expiration_baseline_microdollars_used: null,
            retired_microdollars: 50,
            credit_source: kind === 'settlement' ? 'settlement' : null,
            credit_category: kind === 'accounting_adjustment' ? kind : null,
            paid_credit_policy: kind === 'settlement' ? kind : null,
          },
        ],
      });
      const baseline =
        result.updatesForExpirationBaseline.find(update => update.id === legacy.id)?.baseline ??
        legacy.expiration_baseline_microdollars_used;
      const expiry = computeExpiration(
        [{ ...legacy, expiration_baseline_microdollars_used: baseline }],
        { id: result.user.id, microdollars_used: result.user_update.microdollars_used },
        new Date('2033-01-01'),
        result.user.id
      );
      expect(expiry.newTransactions[0].amount_microdollars).toBe(-60);
    }
  );
});
