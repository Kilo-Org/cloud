import { describe, expect, it } from '@jest/globals';
import { and, asc, eq } from 'drizzle-orm';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { reconcileCreditExpirationsInTransaction } from '@kilocode/db/credit-expiration';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { recordRefundDebtRepayment } from '@kilocode/db/credit-refund-repayments';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  refundCreditTransaction,
  restoreCreditRefund,
  retireCreditBalance,
  transferCreditLots,
} from './creditAdjustments';

const beforeDeadline = new Date('2030-01-01T00:00:00.000Z');
const deadline = '2030-06-01T00:00:00.000Z';
const afterDeadline = new Date('2030-07-01T00:00:00.000Z');

async function sourceLot(used = 0, expiry: string | null = deadline) {
  const user = await insertTestUser({
    total_microdollars_acquired: 100,
    microdollars_used: used,
    next_credit_expiration_at: expiry,
  });
  const [source] = await db
    .insert(credit_transactions)
    .values({
      kilo_user_id: user.id,
      amount_microdollars: 100,
      is_free: false,
      paid_credit_policy: expiry ? 'one_year' : 'apple_exempt',
      credit_source: expiry ? 'google_play' : 'apple',
      expiry_date: expiry,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
    })
    .returning();
  return { user, source };
}

async function balance(userId: string) {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  return user.total_microdollars_acquired - user.microdollars_used;
}

async function refund(
  userId: string,
  sourceId: string,
  amount: number,
  category: string,
  now = beforeDeadline
) {
  return db.transaction(tx =>
    refundCreditTransaction(tx, {
      owner: { type: 'user', id: userId },
      sourceTransactionId: sourceId,
      amountMicrodollars: amount,
      creditCategory: category,
      description: 'Cash refund',
      now,
    })
  );
}

async function restore(
  userId: string,
  sourceId: string,
  refundId: string,
  category: string,
  now = beforeDeadline
) {
  return db.transaction(tx =>
    restoreCreditRefund(tx, {
      owner: { type: 'user', id: userId },
      sourceTransactionId: sourceId,
      refundTransactionId: refundId,
      creditCategory: category,
      description: 'Refund reversed',
      now,
    })
  );
}

async function expire(userId: string, now = afterDeadline) {
  return db.transaction(tx =>
    reconcileCreditExpirationsInTransaction({ type: 'user', id: userId }, tx, now)
  );
}

async function repaymentGrant(userId: string, amount: number, expiry = '2031-01-01T00:00:00.000Z') {
  return db.transaction(async tx => {
    const [owner] = await tx
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('update');
    const [grant] = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: userId,
        amount_microdollars: amount,
        is_free: false,
        expiry_date: expiry,
        paid_credit_policy: 'one_year',
        credit_source: 'stripe',
        original_baseline_microdollars_used: Math.min(
          owner.microdollars_used,
          owner.total_microdollars_acquired
        ),
        expiration_baseline_microdollars_used: Math.min(
          owner.microdollars_used,
          owner.total_microdollars_acquired
        ),
      })
      .returning();
    await recordRefundDebtRepayment(tx, {
      owner: { type: 'user', id: userId },
      transactionId: grant.id,
      priorUsed: owner.microdollars_used,
      priorAcquired: owner.total_microdollars_acquired,
      amountMicrodollars: amount,
    });
    await tx
      .update(kilocode_users)
      .set({ total_microdollars_acquired: owner.total_microdollars_acquired + amount })
      .where(eq(kilocode_users.id, userId));
    return grant;
  });
}

describe('source-lot credit adjustments', () => {
  it('retires a full refund without reclaiming it again at expiry', async () => {
    const { user, source } = await sourceLot(40);
    const result = await refund(user.id, source.id, 100, 'full-refund');
    expect(result.amountMicrodollars).toBe(100);
    expect(await balance(user.id)).toBe(-40);
    await expire(user.id);
    expect(await balance(user.id)).toBe(-40);
    const [lot] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, source.id));
    expect(lot).toMatchObject({
      amount_microdollars: 100,
      consumed_microdollars: 40,
      retired_microdollars: 60,
    });
    const [entry] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, result.creditTransactionId));
    expect(entry).toMatchObject({
      source_transaction_id: source.id,
      original_transaction_id: null,
      refund_principal_microdollars: -100,
    });
  });

  it('keeps prior usage allocation when a partially consumed lot is partially refunded', async () => {
    const { user, source } = await sourceLot(40);
    await refund(user.id, source.id, 30, 'partial-refund');
    expect(await balance(user.id)).toBe(30);
    await expire(user.id);
    expect(await balance(user.id)).toBe(0);
    const [closure] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.original_transaction_id, source.id));
    expect(closure.amount_microdollars).toBe(-30);
  });

  it('reconciles overdue expiry before cash refund and reclaims only spent principal as debt', async () => {
    const { user, source } = await sourceLot(40);
    const result = await refund(user.id, source.id, 100, 'late-refund', afterDeadline);
    expect(result.amountMicrodollars).toBe(40);
    expect(await balance(user.id)).toBe(-40);
    await expire(user.id);
    expect(await balance(user.id)).toBe(-40);
    const [entry] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, result.creditTransactionId));
    expect(entry.refund_principal_microdollars).toBe(-100);
  });

  it('records a zero-balance refund of fully expired principal once', async () => {
    const { user, source } = await sourceLot();
    const result = await refund(user.id, source.id, 100, 'expired-refund', afterDeadline);
    expect(result).toMatchObject({ wasInserted: true, amountMicrodollars: 0 });
    expect(await refund(user.id, source.id, 100, 'expired-refund', afterDeadline)).toMatchObject({
      wasInserted: false,
      amountMicrodollars: 0,
    });
    expect(await balance(user.id)).toBe(0);
    const reversal = await restore(
      user.id,
      source.id,
      result.creditTransactionId,
      'expired-reversal',
      afterDeadline
    );
    expect(reversal).toMatchObject({ wasInserted: true, amountMicrodollars: 0 });
    expect(await balance(user.id)).toBe(0);
  });

  it('restores a partial refund to the original deadline and cohort without new principal', async () => {
    const { user, source } = await sourceLot(40);
    const debit = await refund(user.id, source.id, 30, 'partial-refund');
    const reversal = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'partial-reversal'
    );
    expect(reversal.amountMicrodollars).toBe(30);
    expect(await balance(user.id)).toBe(60);
    const [entry] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, reversal.creditTransactionId));
    expect({
      ...entry,
      expiry_date: entry.expiry_date ? new Date(entry.expiry_date).toISOString() : null,
    }).toMatchObject({
      expiry_date: deadline,
      paid_credit_policy: 'one_year',
      credit_source: 'google_play',
      source_transaction_id: debit.creditTransactionId,
      retired_microdollars: 30,
      refund_principal_microdollars: 30,
    });
    await expire(user.id);
    expect(await balance(user.id)).toBe(0);
  });

  it('never resurrects expired unspent principal when reversing a refund after its deadline', async () => {
    const { user, source } = await sourceLot(40);
    const debit = await refund(user.id, source.id, 100, 'refund');
    const reversal = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'reversal',
      afterDeadline
    );
    expect(reversal.amountMicrodollars).toBe(40);
    expect(await balance(user.id)).toBe(0);
    const second = await refund(user.id, source.id, 100, 'refund-second-cycle', afterDeadline);
    expect(second.amountMicrodollars).toBe(40);
    expect(await balance(user.id)).toBe(-40);
  });

  it('preserves Apple-exempt refunds and reversals without introducing an expiry', async () => {
    const { user, source } = await sourceLot(10, null);
    const debit = await refund(user.id, source.id, 50, 'apple-refund');
    await restore(user.id, source.id, debit.creditTransactionId, 'apple-reversal', afterDeadline);
    expect(await balance(user.id)).toBe(90);
    const [lot] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, source.id));
    expect(lot).toMatchObject({
      expiry_date: null,
      paid_credit_policy: 'apple_exempt',
      credit_source: 'apple',
      retired_microdollars: 0,
    });
  });

  it('serializes duplicate refunds and reversals even without a caller advisory lock', async () => {
    const { user, source } = await sourceLot(20);
    const refunds = await Promise.all(
      Array.from({ length: 3 }, () => refund(user.id, source.id, 100, 'concurrent-refund'))
    );
    expect(refunds.filter(result => result.wasInserted)).toHaveLength(1);
    expect(await balance(user.id)).toBe(-20);
    const debit = refunds.find(result => result.wasInserted);
    if (!debit) throw new Error('Expected refund');
    const reversals = await Promise.all(
      Array.from({ length: 3 }, () =>
        restore(user.id, source.id, debit.creditTransactionId, 'concurrent-reversal')
      )
    );
    expect(reversals.filter(result => result.wasInserted)).toHaveLength(1);
    expect(await balance(user.id)).toBe(80);
  });

  it('retires administrative partial adjustments and resets without expiring them twice', async () => {
    const { user, source } = await sourceLot(20);
    await db.transaction(tx =>
      retireCreditBalance(tx, {
        owner: { type: 'user', id: user.id },
        actorId: user.id,
        creditCategory: 'admin-adjustment',
        description: 'Partial removal',
        amountMicrodollars: 30,
        now: beforeDeadline,
      })
    );
    expect(await balance(user.id)).toBe(50);
    await db.transaction(tx =>
      retireCreditBalance(tx, {
        owner: { type: 'user', id: user.id },
        actorId: user.id,
        creditCategory: 'admin-reset',
        description: 'Reset',
        now: beforeDeadline,
      })
    );
    expect(await balance(user.id)).toBe(0);
    await expire(user.id);
    expect(await balance(user.id)).toBe(0);
    const linked = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.source_transaction_id, source.id));
    expect(linked.map(row => row.amount_microdollars).sort((a, b) => a - b)).toEqual([-50, -30]);
    expect(linked.every(row => row.is_free)).toBe(true);
  });

  it('restores absorbed refund debt to the later repayment lot rather than the original expired cohort', async () => {
    const { user, source } = await sourceLot(20);
    const debit = await refund(user.id, source.id, 100, 'refund');
    const repaid = await repaymentGrant(user.id, 100);
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 70 })
      .where(eq(kilocode_users.id, user.id));
    expect(await balance(user.id)).toBe(30);
    const restored = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'reversal',
      afterDeadline
    );
    expect(restored.amountMicrodollars).toBe(20);
    expect(await balance(user.id)).toBe(50);
    const [lot] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, repaid.id));
    expect(lot.consumed_microdollars).toBe(50);
    await expire(user.id, new Date('2031-02-01T00:00:00.000Z'));
    expect(await balance(user.id)).toBe(0);
  });

  it('restores original unspent principal and debt repaid by later credits before the original deadline', async () => {
    const { user, source } = await sourceLot(20);
    const debit = await refund(user.id, source.id, 100, 'refund');
    await repaymentGrant(user.id, 100);
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 70 })
      .where(eq(kilocode_users.id, user.id));
    await restore(user.id, source.id, debit.creditTransactionId, 'reversal');
    expect(await balance(user.id)).toBe(130);
    await expire(user.id);
    expect(await balance(user.id)).toBe(50);
  });

  it('does not restore debt repayment principal whose own source deadline already passed', async () => {
    const { user, source } = await sourceLot(20);
    const debit = await refund(user.id, source.id, 100, 'refund');
    await repaymentGrant(user.id, 100);
    const restored = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'reversal',
      new Date('2031-02-01T00:00:00.000Z')
    );
    expect(restored.amountMicrodollars).toBe(0);
    expect(await balance(user.id)).toBe(0);
  });

  it('retires other available source lots when refunded spent principal is funded by the current balance', async () => {
    const { user, source } = await sourceLot(100);
    const available = await repaymentGrant(user.id, 100);
    const debit = await refund(user.id, source.id, 100, 'refund');
    expect(await balance(user.id)).toBe(0);
    await expire(user.id);
    expect(await balance(user.id)).toBe(0);
    const restored = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'reversal',
      afterDeadline
    );
    expect(restored.amountMicrodollars).toBe(100);
    const [lot] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.id, available.id));
    expect(lot.retired_microdollars).toBe(0);
    expect(await balance(user.id)).toBe(100);
  });

  it('pays preexisting usage debt before attributing a later grant to refundable debt', async () => {
    const { user, source } = await sourceLot(120);
    const debit = await refund(user.id, source.id, 100, 'refund');
    const repayment = await repaymentGrant(user.id, 50);
    expect(await balance(user.id)).toBe(-70);
    const [allocation] = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.source_transaction_id, repayment.id),
          eq(
            credit_transactions.credit_category,
            `refund_debt_absorbed:${debit.creditTransactionId}`
          )
        )
      );
    expect(allocation.consumed_microdollars).toBe(30);
    const restored = await restore(
      user.id,
      source.id,
      debit.creditTransactionId,
      'reversal',
      new Date('2031-02-01T00:00:00.000Z')
    );
    expect(restored.amountMicrodollars).toBe(70);
    expect(await balance(user.id)).toBe(0);
  });

  it('allows a requested administrative debit to create debt without negative exposure', async () => {
    const { user } = await sourceLot(80);
    await db.transaction(tx =>
      retireCreditBalance(tx, {
        owner: { type: 'user', id: user.id },
        actorId: user.id,
        creditCategory: 'admin-debit',
        description: 'Debit',
        amountMicrodollars: 50,
        now: beforeDeadline,
      })
    );
    expect(await balance(user.id)).toBe(-30);
    await expire(user.id);
    expect(await balance(user.id)).toBe(-30);
  });
});

type LotSpec = Pick<
  typeof credit_transactions.$inferInsert,
  'amount_microdollars' | 'expiry_date' | 'paid_credit_policy' | 'credit_source' | 'is_free'
>;

async function ownerWithLots<K extends string>(used: number, specs: Record<K, LotSpec>) {
  const entries = Object.entries(specs) as [K, LotSpec][];
  const user = await insertTestUser({
    total_microdollars_acquired: entries.reduce(
      (sum, [, spec]) => sum + spec.amount_microdollars,
      0
    ),
    microdollars_used: used,
  });
  const lots = {} as Record<K, typeof credit_transactions.$inferSelect>;
  for (const [key, spec] of entries) {
    const [lot] = await db
      .insert(credit_transactions)
      .values({
        ...spec,
        kilo_user_id: user.id,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
      })
      .returning();
    lots[key] = lot;
  }
  return { user, lots };
}

async function lotRow(id: string) {
  const [lot] = await db.select().from(credit_transactions).where(eq(credit_transactions.id, id));
  return lot;
}

const laterDeadline = '2031-01-01T00:00:00.000Z';
const afterLaterDeadline = new Date('2031-02-01T00:00:00.000Z');

describe('interleaved refund reversals', () => {
  // Apple Pass month: exempt base 190 and dated bonus 95, with 150 used and the bonus spent first.
  const passLots = () =>
    ownerWithLots(150, {
      base: {
        amount_microdollars: 190,
        expiry_date: null,
        paid_credit_policy: 'apple_exempt',
        credit_source: 'apple',
        is_free: false,
      },
      bonus: {
        amount_microdollars: 95,
        expiry_date: deadline,
        paid_credit_policy: null,
        credit_source: 'apple',
        is_free: true,
      },
    });

  it.each([
    ['base', 'bonus'],
    ['bonus', 'base'],
  ] as const)(
    'restores the full Kilo Pass balance when the %s refund is reversed first',
    async (first, second) => {
      const { user, lots } = await passLots();
      const refunds = {
        base: await refund(user.id, lots.base.id, 190, 'pass-base-refund'),
        bonus: await refund(user.id, lots.bonus.id, 95, 'pass-bonus-refund'),
      };
      expect(await lotRow(refunds.base.creditTransactionId)).toMatchObject({
        amount_microdollars: -190,
        retired_microdollars: 135,
      });
      expect(await lotRow(refunds.bonus.creditTransactionId)).toMatchObject({
        amount_microdollars: -95,
        retired_microdollars: 0,
      });
      expect(await balance(user.id)).toBe(-150);
      await restore(
        user.id,
        lots[first].id,
        refunds[first].creditTransactionId,
        `pass-${first}-reversal`
      );
      expect(await balance(user.id)).toBe(first === 'base' ? 40 : -55);
      await restore(
        user.id,
        lots[second].id,
        refunds[second].creditTransactionId,
        `pass-${second}-reversal`
      );
      expect(await balance(user.id)).toBe(135);
      expect(
        await restore(
          user.id,
          lots[first].id,
          refunds[first].creditTransactionId,
          `pass-${first}-reversal`
        )
      ).toMatchObject({ wasInserted: false, amountMicrodollars: 0 });
      expect(await balance(user.id)).toBe(135);
      expect(await lotRow(lots.base.id)).toMatchObject({
        expiry_date: null,
        consumed_microdollars: 55,
        retired_microdollars: 0,
      });
      expect(await lotRow(lots.bonus.id)).toMatchObject({
        consumed_microdollars: 95,
        retired_microdollars: 0,
      });
      await expire(user.id);
      expect(await balance(user.id)).toBe(135);
    }
  );

  // Store packs: A (earlier deadline) fully spent, C (later deadline) with 80 unspent.
  const packLots = () =>
    ownerWithLots(120, {
      a: {
        amount_microdollars: 100,
        expiry_date: deadline,
        paid_credit_policy: 'one_year',
        credit_source: 'google_play',
        is_free: false,
      },
      c: {
        amount_microdollars: 100,
        expiry_date: laterDeadline,
        paid_credit_policy: 'one_year',
        credit_source: 'google_play',
        is_free: false,
      },
    });

  async function refundBothPacks() {
    const { user, lots } = await packLots();
    const refunds = {
      c: await refund(user.id, lots.c.id, 100, 'pack-c-refund'),
      a: await refund(user.id, lots.a.id, 100, 'pack-a-refund'),
    };
    expect(await balance(user.id)).toBe(-120);
    return { user, lots, refunds };
  }

  it.each([
    ['c', 'a'],
    ['a', 'c'],
  ] as const)('restores both store packs when pack %s is reversed first', async (first, second) => {
    const { user, lots, refunds } = await refundBothPacks();
    await restore(
      user.id,
      lots[first].id,
      refunds[first].creditTransactionId,
      `pack-${first}-reversal`
    );
    expect(await balance(user.id)).toBe(-20);
    await restore(
      user.id,
      lots[second].id,
      refunds[second].creditTransactionId,
      `pack-${second}-reversal`
    );
    expect(await balance(user.id)).toBe(80);
    expect(await lotRow(lots.c.id)).toMatchObject({
      consumed_microdollars: 20,
      retired_microdollars: 0,
    });
    await expire(user.id);
    expect(await balance(user.id)).toBe(80);
    await expire(user.id, afterLaterDeadline);
    expect(await balance(user.id)).toBe(0);
  });

  it('attributes debt absorbed by restored principal to the restoring lot and its deadline', async () => {
    const { user, lots, refunds } = await refundBothPacks();
    await restore(user.id, lots.c.id, refunds.c.creditTransactionId, 'pack-c-reversal');
    const [allocation] = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(
            credit_transactions.credit_category,
            `refund_debt_absorbed:${refunds.a.creditTransactionId}`
          )
        )
      );
    expect({
      ...allocation,
      expiry_date: allocation.expiry_date ? new Date(allocation.expiry_date).toISOString() : null,
    }).toMatchObject({
      source_transaction_id: lots.c.id,
      amount_microdollars: 0,
      consumed_microdollars: 80,
      expiry_date: laterDeadline,
    });
    expect(await lotRow(lots.c.id)).toMatchObject({
      consumed_microdollars: 100,
      retired_microdollars: 0,
    });
  });

  it('does not resurrect restored principal whose restoring lot expired before the later reversal', async () => {
    const { user, lots, refunds } = await refundBothPacks();
    await restore(user.id, lots.c.id, refunds.c.creditTransactionId, 'pack-c-reversal');
    const reversal = await restore(
      user.id,
      lots.a.id,
      refunds.a.creditTransactionId,
      'pack-a-reversal',
      afterLaterDeadline
    );
    expect(reversal.amountMicrodollars).toBe(20);
    expect(await balance(user.id)).toBe(0);
  });

  it('covers unrelated usage debt before attributing restored principal to other refunds', async () => {
    const { user, lots, refunds } = await refundBothPacks();
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 150 })
      .where(eq(kilocode_users.id, user.id));
    await restore(user.id, lots.c.id, refunds.c.creditTransactionId, 'pack-c-reversal');
    expect(await balance(user.id)).toBe(-50);
    const [allocation] = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(
            credit_transactions.credit_category,
            `refund_debt_absorbed:${refunds.a.creditTransactionId}`
          )
        )
      );
    expect(allocation.consumed_microdollars).toBe(50);
    await restore(user.id, lots.a.id, refunds.a.creditTransactionId, 'pack-a-reversal');
    expect(await balance(user.id)).toBe(50);
  });
});

async function transfer(fromId: string, toId: string, amount: number, now = beforeDeadline) {
  return db.transaction(tx =>
    transferCreditLots(tx, {
      from: { type: 'user', id: fromId },
      to: { type: 'user', id: toId },
      actorId: fromId,
      amountMicrodollars: amount,
      incomingCategory: 'parent_to_child_transfer_in',
      outgoingCategory: 'parent_to_child_transfer_out',
      incomingDescription: 'Incoming transfer',
      outgoingDescription: 'Outgoing transfer',
      now,
    })
  );
}

describe('source-lot transfers', () => {
  it('preserves a nonexpiring Apple lot after earlier expiry has claimed prior usage', async () => {
    const source = await insertTestUser({
      total_microdollars_acquired: 200,
      microdollars_used: 40,
    });
    const target = await insertTestUser();
    const [, apple] = await db
      .insert(credit_transactions)
      .values([
        {
          kilo_user_id: source.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: deadline,
          paid_credit_policy: 'one_year',
          credit_source: 'stripe',
          expiration_baseline_microdollars_used: 0,
        },
        {
          kilo_user_id: source.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: null,
          paid_credit_policy: 'apple_exempt',
          credit_source: 'apple',
          expiration_baseline_microdollars_used: 0,
        },
      ])
      .returning();
    await transfer(source.id, target.id, 100, afterDeadline);
    const incoming = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, target.id),
          eq(credit_transactions.credit_category, 'parent_to_child_transfer_in')
        )
      );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      amount_microdollars: 100,
      source_transaction_id: apple.id,
      credit_source: 'apple',
      paid_credit_policy: 'apple_exempt',
      expiry_date: null,
    });
  });

  it('breaks equal-deadline ties by source transaction id before splitting lots', async () => {
    const source = await insertTestUser({
      total_microdollars_acquired: 200,
      microdollars_used: 20,
    });
    const target = await insertTestUser();
    const ids = [crypto.randomUUID(), crypto.randomUUID()].sort();
    await db.insert(credit_transactions).values(
      ids.map(id => ({
        id,
        kilo_user_id: source.id,
        amount_microdollars: 100,
        is_free: false,
        expiry_date: deadline,
        paid_credit_policy: 'one_year',
        credit_source: 'stripe',
        expiration_baseline_microdollars_used: 0,
      }))
    );
    await transfer(source.id, target.id, 100);
    const incoming = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, target.id),
          eq(credit_transactions.credit_category, 'parent_to_child_transfer_in')
        )
      )
      .orderBy(asc(credit_transactions.source_transaction_id));
    expect(incoming.map(row => [row.source_transaction_id, row.amount_microdollars])).toEqual([
      [ids[0], 80],
      [ids[1], 20],
    ]);
  });

  it('splits partially consumed mixed-deadline lots in expiry order and keeps reverse-transfer cohorts', async () => {
    const source = await insertTestUser({
      total_microdollars_acquired: 300,
      microdollars_used: 40,
    });
    const target = await insertTestUser();
    const [early, late, legacy] = await db
      .insert(credit_transactions)
      .values([
        {
          kilo_user_id: source.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: deadline,
          paid_credit_policy: 'one_year',
          credit_source: 'stripe',
          expiration_baseline_microdollars_used: 0,
        },
        {
          kilo_user_id: source.id,
          amount_microdollars: 100,
          is_free: true,
          expiry_date: '2030-08-01T00:00:00.000Z',
          paid_credit_policy: 'one_year',
          credit_source: 'pass',
          expiration_baseline_microdollars_used: 0,
        },
        {
          kilo_user_id: source.id,
          amount_microdollars: 100,
          is_free: false,
          expiry_date: null,
          paid_credit_policy: 'apple_exempt',
          credit_source: 'apple',
          expiration_baseline_microdollars_used: 0,
        },
      ])
      .returning();
    await transfer(source.id, target.id, 180);
    expect(await balance(source.id)).toBe(80);
    expect(await balance(target.id)).toBe(180);
    const incoming = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, target.id),
          eq(credit_transactions.credit_category, 'parent_to_child_transfer_in')
        )
      )
      .orderBy(asc(credit_transactions.expiry_date));
    expect(
      incoming.map(row => [
        row.amount_microdollars,
        row.expiry_date ? new Date(row.expiry_date).toISOString() : null,
        row.credit_source,
        row.source_transaction_id,
      ])
    ).toEqual([
      [60, deadline, 'stripe', early.id],
      [100, '2030-08-01T00:00:00.000Z', 'pass', late.id],
      [20, null, 'apple', legacy.id],
    ]);
    await transfer(target.id, source.id, 80);
    const reverse = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, source.id),
          eq(credit_transactions.credit_category, 'parent_to_child_transfer_in')
        )
      )
      .orderBy(asc(credit_transactions.expiry_date));
    expect(
      reverse.map(row => [
        row.amount_microdollars,
        new Date(row.expiry_date ?? '').toISOString(),
        row.credit_source,
      ])
    ).toEqual([
      [60, deadline, 'stripe'],
      [20, '2030-08-01T00:00:00.000Z', 'pass'],
    ]);
    expect(reverse.map(row => row.source_transaction_id)).toEqual(
      incoming.slice(0, 2).map(row => row.id)
    );
    await expire(source.id);
    await expire(target.id);
    expect(await balance(source.id)).toBe(100);
    expect(await balance(target.id)).toBe(100);
  });

  it('allows nonexpiring legacy counter remainder transfers with no lot ledger', async () => {
    const source = await insertTestUser({
      total_microdollars_acquired: 100,
      microdollars_used: 20,
    });
    const target = await insertTestUser();
    await transfer(source.id, target.id, 80);
    expect(await balance(source.id)).toBe(0);
    expect(await balance(target.id)).toBe(80);
    const [incoming] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, target.id));
    expect(incoming).toMatchObject({
      paid_credit_policy: 'legacy',
      expiry_date: null,
      is_free: true,
    });
  });

  it('accounts for destination debt before a transferred grant expires', async () => {
    const { user } = await sourceLot();
    const target = await insertTestUser({ total_microdollars_acquired: 0, microdollars_used: 20 });
    await transfer(user.id, target.id, 100);
    expect(await balance(target.id)).toBe(80);
    await expire(target.id);
    expect(await balance(target.id)).toBe(0);
  });

  it('serializes opposite-direction transfers without deadlock or duplicated balances', async () => {
    const left = await sourceLot();
    const right = await sourceLot();
    await Promise.all([
      transfer(left.user.id, right.user.id, 30),
      transfer(right.user.id, left.user.id, 40),
    ]);
    expect(await balance(left.user.id)).toBe(110);
    expect(await balance(right.user.id)).toBe(90);
    await expire(left.user.id);
    await expire(right.user.id);
    expect(await balance(left.user.id)).toBe(0);
    expect(await balance(right.user.id)).toBe(0);
  });

  it('rejects concurrent overspending transfers while preserving the winning source lot', async () => {
    const { user } = await sourceLot();
    const targetA = await insertTestUser();
    const targetB = await insertTestUser();
    const results = await Promise.allSettled([
      transfer(user.id, targetA.id, 70),
      transfer(user.id, targetB.id, 70),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(user.id)).toBe(30);
    expect((await balance(targetA.id)) + (await balance(targetB.id))).toBe(70);
  });
});
