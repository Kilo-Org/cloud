import {
  credit_transactions,
  kilocode_users,
  organizations,
  type CreditTransaction,
} from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  computeCreditLotAllocations,
  reconcileCreditExpirationsInTransaction,
  type CreditExpirationOwnerState,
  type CreditOwner,
} from '@kilocode/db/credit-expiration';
import {
  outstandingRefundDebts,
  recordRefundDebtRepayment,
  refundDebtAllocationCategory,
} from '@kilocode/db/credit-refund-repayments';
import { and, asc, eq, gt, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type OwnerState = CreditExpirationOwnerState;
type AdjustmentResult = {
  wasInserted: boolean;
  creditTransactionId: string;
  amountMicrodollars: number;
};

function ownerFilter(owner: CreditOwner) {
  return owner.type === 'organization'
    ? eq(credit_transactions.organization_id, owner.id)
    : and(
        eq(credit_transactions.kilo_user_id, owner.id),
        isNull(credit_transactions.organization_id)
      );
}

export async function lockCreditOwners(
  tx: DrizzleTransaction,
  owners: CreditOwner[],
  now = new Date()
): Promise<Map<string, OwnerState>> {
  const ordered = [
    ...new Map(owners.map(owner => [`${owner.type}:${owner.id}`, owner])).values(),
  ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const states = new Map<string, OwnerState>();
  for (const owner of ordered) {
    states.set(
      `${owner.type}:${owner.id}`,
      await reconcileCreditExpirationsInTransaction(owner, tx, now)
    );
  }
  return states;
}

async function normalizeCreditLots(tx: DrizzleTransaction, owner: CreditOwner, state: OwnerState) {
  const closures = alias(credit_transactions, 'adjustment_expiration_closures');
  const lots = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        ownerFilter(owner),
        gt(credit_transactions.amount_microdollars, 0),
        sql`${credit_transactions.paid_credit_policy} IS DISTINCT FROM 'settlement'`,
        notExists(
          tx
            .select({ id: closures.id })
            .from(closures)
            .where(
              and(
                eq(closures.original_transaction_id, credit_transactions.id),
                inArray(closures.credit_category, [
                  'credits_expired',
                  'orb_credit_expired',
                  'orb_credit_voided',
                ])
              )
            )
        )
      )
    );
  const allocations = computeCreditLotAllocations(lots, state);
  for (const allocation of allocations) {
    await tx
      .update(credit_transactions)
      .set({
        consumed_microdollars:
          (allocation.transaction.consumed_microdollars ?? 0) + allocation.consumed_microdollars,
        expiration_baseline_microdollars_used: state.microdollars_used,
      })
      .where(eq(credit_transactions.id, allocation.transaction.id));
  }
  return allocations;
}

async function moveBalance(tx: DrizzleTransaction, owner: CreditOwner, amount: number) {
  if (owner.type === 'user') {
    await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${amount}`,
      })
      .where(eq(kilocode_users.id, owner.id));
  } else {
    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${amount}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${amount}`,
      })
      .where(eq(organizations.id, owner.id));
  }
}

async function refreshExpirationPointer(tx: DrizzleTransaction, owner: CreditOwner) {
  const closures = alias(credit_transactions, 'adjustment_pointer_closures');
  const [next] = await tx
    .select({ expiry_date: credit_transactions.expiry_date })
    .from(credit_transactions)
    .where(
      and(
        ownerFilter(owner),
        gt(credit_transactions.amount_microdollars, 0),
        sql`${credit_transactions.amount_microdollars} > ${credit_transactions.retired_microdollars} + ${credit_transactions.consumed_microdollars}`,
        sql`${credit_transactions.expiry_date} IS NOT NULL`,
        notExists(
          tx
            .select({ id: closures.id })
            .from(closures)
            .where(eq(closures.original_transaction_id, credit_transactions.id))
        )
      )
    )
    .orderBy(asc(credit_transactions.expiry_date), asc(credit_transactions.id))
    .limit(1);
  if (owner.type === 'user') {
    await tx
      .update(kilocode_users)
      .set({ next_credit_expiration_at: next?.expiry_date ?? null })
      .where(eq(kilocode_users.id, owner.id));
  } else {
    await tx
      .update(organizations)
      .set({ next_credit_expiration_at: next?.expiry_date ?? null })
      .where(eq(organizations.id, owner.id));
  }
}

type LotProvenance = Pick<
  CreditTransaction,
  'paid_credit_policy' | 'credit_source' | 'expiry_date'
>;

function provenance(source: CreditTransaction): LotProvenance {
  return {
    paid_credit_policy: source.paid_credit_policy ?? (source.is_free ? null : 'legacy'),
    credit_source: source.credit_source,
    expiry_date: source.expiry_date,
  };
}

async function existingAdjustment(tx: DrizzleTransaction, owner: CreditOwner, category: string) {
  const [existing] = await tx
    .select()
    .from(credit_transactions)
    .where(and(ownerFilter(owner), eq(credit_transactions.credit_category, category)))
    .limit(1);
  return existing;
}

export async function refundCreditTransaction(
  tx: DrizzleTransaction,
  params: {
    owner: CreditOwner;
    sourceTransactionId: string;
    amountMicrodollars: number;
    creditCategory: string;
    description: string;
    actorId?: string;
    now?: Date;
  }
): Promise<AdjustmentResult> {
  const now = params.now ?? new Date();
  const state = await reconcileCreditExpirationsInTransaction(params.owner, tx, now);
  const existing = await existingAdjustment(tx, params.owner, params.creditCategory);
  if (existing)
    return { wasInserted: false, creditTransactionId: existing.id, amountMicrodollars: 0 };
  const allocations = await normalizeCreditLots(tx, params.owner, state);
  const [source] = await tx
    .select()
    .from(credit_transactions)
    .where(and(ownerFilter(params.owner), eq(credit_transactions.id, params.sourceTransactionId)))
    .limit(1);
  if (!source || source.amount_microdollars <= 0)
    throw new Error('Credit source transaction not found');
  const [expiration] = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.original_transaction_id, source.id),
        inArray(credit_transactions.credit_category, [
          'credits_expired',
          'orb_credit_expired',
          'orb_credit_voided',
        ])
      )
    )
    .limit(1);
  const requested = Math.max(
    0,
    Math.min(source.amount_microdollars, Math.round(params.amountMicrodollars))
  );
  const alreadyExpired =
    Math.max(0, -(expiration?.amount_microdollars ?? 0)) +
    (source.expiry_date !== null && new Date(source.expiry_date) <= now
      ? source.retired_microdollars
      : 0);
  const amount = Math.max(0, requested - alreadyExpired);
  const retirement = expiration
    ? 0
    : Math.min(
        requested,
        Math.max(
          0,
          source.amount_microdollars - source.retired_microdollars - source.consumed_microdollars
        )
      );
  const id = crypto.randomUUID();
  await tx.insert(credit_transactions).values({
    id,
    kilo_user_id: source.kilo_user_id,
    organization_id: source.organization_id,
    created_by_kilo_user_id: params.actorId,
    source_transaction_id: source.id,
    ...provenance(source),
    amount_microdollars: -amount,
    refund_principal_microdollars: -requested,
    retired_microdollars: retirement,
    consumed_microdollars: source.consumed_microdollars,
    is_free: source.is_free,
    credit_category: params.creditCategory,
    check_category_uniqueness: true,
    description: params.description,
    created_at: now.toISOString(),
    original_baseline_microdollars_used: state.microdollars_used,
  });
  if (retirement > 0) {
    await tx
      .update(credit_transactions)
      .set({ retired_microdollars: source.retired_microdollars + retirement })
      .where(eq(credit_transactions.id, source.id));
  }
  let fundedSpent = Math.min(
    amount - retirement,
    Math.max(0, state.total_microdollars_acquired - state.microdollars_used - retirement)
  );
  for (const allocation of allocations) {
    if (allocation.transaction.id === source.id) continue;
    const retired = Math.min(fundedSpent, allocation.remaining_microdollars);
    if (retired <= 0) continue;
    const repaymentSource = allocation.transaction;
    await tx
      .update(credit_transactions)
      .set({
        retired_microdollars: repaymentSource.retired_microdollars + retired,
      })
      .where(eq(credit_transactions.id, repaymentSource.id));
    await tx.insert(credit_transactions).values({
      kilo_user_id: source.kilo_user_id,
      organization_id: source.organization_id,
      source_transaction_id: repaymentSource.id,
      ...provenance(repaymentSource),
      amount_microdollars: 0,
      retired_microdollars: retired,
      is_free: true,
      credit_category: refundDebtAllocationCategory(id),
      description: 'Refund spent principal absorbed by available credits',
      created_at: now.toISOString(),
      original_baseline_microdollars_used: state.microdollars_used,
    });
    fundedSpent -= retired;
  }
  if (fundedSpent > 0) {
    await tx.insert(credit_transactions).values({
      kilo_user_id: source.kilo_user_id,
      organization_id: source.organization_id,
      amount_microdollars: 0,
      retired_microdollars: fundedSpent,
      paid_credit_policy: 'legacy',
      is_free: true,
      credit_category: refundDebtAllocationCategory(id),
      description: 'Refund spent principal absorbed by legacy balance',
      created_at: now.toISOString(),
      original_baseline_microdollars_used: state.microdollars_used,
    });
  }
  await moveBalance(tx, params.owner, -amount);
  await refreshExpirationPointer(tx, params.owner);
  return { wasInserted: true, creditTransactionId: id, amountMicrodollars: amount };
}

const LEGACY_PROVENANCE: LotProvenance = {
  paid_credit_policy: 'legacy',
  credit_source: null,
  expiry_date: null,
};

type RestoredExposure = {
  /** The lot whose exposure was restored; null for untracked legacy balance. */
  lotId: string | null;
  exposure: number;
  provenance: LotProvenance;
};

/**
 * Restored exposure first covers the owner's remaining debt. Debt from other refunds still in force
 * gets a repayment allocation on the restoring lot, as a new grant would, so reversing that refund
 * later returns the principal to this lot under its own deadline.
 */
async function absorbRemainingDebt(
  tx: DrizzleTransaction,
  params: {
    owner: CreditOwner;
    holder: CreditTransaction;
    restored: RestoredExposure[];
    debtMicrodollars: number;
    usedMicrodollars: number;
    now: Date;
  }
) {
  let debt = params.debtMicrodollars;
  if (debt <= 0 || params.restored.length === 0) return;
  const refundDebts = await outstandingRefundDebts(tx, params.owner);
  let unrelatedDebt = Math.max(
    0,
    debt - refundDebts.reduce((sum, refundDebt) => sum + refundDebt.amount, 0)
  );
  const expiryOf = ({ provenance: { expiry_date } }: RestoredExposure) =>
    expiry_date === null ? Infinity : new Date(expiry_date).getTime();
  // Same order as usage claims lots: earliest deadline first, nonexpiring last, untracked balance after lots.
  const ordered = [...params.restored].sort(
    (a, b) =>
      expiryOf(a) - expiryOf(b) ||
      Number(a.lotId === null) - Number(b.lotId === null) ||
      (a.lotId ?? '').localeCompare(b.lotId ?? '')
  );
  for (const lot of ordered) {
    const absorbed = Math.min(lot.exposure, debt);
    if (absorbed <= 0) break;
    debt -= absorbed;
    if (lot.lotId) {
      await tx
        .update(credit_transactions)
        .set({
          consumed_microdollars: sql`${credit_transactions.consumed_microdollars} + ${absorbed}`,
        })
        .where(eq(credit_transactions.id, lot.lotId));
    }
    const coversUnrelated = Math.min(absorbed, unrelatedDebt);
    unrelatedDebt -= coversUnrelated;
    let attributable = absorbed - coversUnrelated;
    for (const refundDebt of refundDebts) {
      const share = Math.min(attributable, refundDebt.amount);
      if (share <= 0) continue;
      await tx.insert(credit_transactions).values({
        kilo_user_id: params.holder.kilo_user_id,
        organization_id: params.holder.organization_id,
        source_transaction_id: lot.lotId,
        ...lot.provenance,
        amount_microdollars: 0,
        consumed_microdollars: share,
        is_free: true,
        credit_category: refundDebtAllocationCategory(refundDebt.refund.id),
        description: 'Refund debt absorbed by restored credits',
        created_at: params.now.toISOString(),
        original_baseline_microdollars_used: params.usedMicrodollars,
      });
      refundDebt.amount -= share;
      attributable -= share;
    }
  }
}

export async function restoreCreditRefund(
  tx: DrizzleTransaction,
  params: {
    owner: CreditOwner;
    sourceTransactionId: string;
    refundTransactionId: string;
    creditCategory: string;
    description: string;
    actorId?: string;
    now?: Date;
  }
): Promise<AdjustmentResult> {
  const now = params.now ?? new Date();
  const state = await reconcileCreditExpirationsInTransaction(params.owner, tx, now);
  const existing = await existingAdjustment(tx, params.owner, params.creditCategory);
  if (existing)
    return { wasInserted: false, creditTransactionId: existing.id, amountMicrodollars: 0 };
  await normalizeCreditLots(tx, params.owner, state);
  const rows = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        ownerFilter(params.owner),
        inArray(credit_transactions.id, [params.sourceTransactionId, params.refundTransactionId])
      )
    );
  const source = rows.find(row => row.id === params.sourceTransactionId);
  const refund = rows.find(row => row.id === params.refundTransactionId);
  if (!source || !refund || refund.amount_microdollars > 0)
    throw new Error('Credit refund transaction not found');
  const allocations = await tx
    .select()
    .from(credit_transactions)
    .where(
      and(
        ownerFilter(params.owner),
        eq(credit_transactions.credit_category, refundDebtAllocationCategory(refund.id))
      )
    )
    .orderBy(asc(credit_transactions.created_at), asc(credit_transactions.id));
  const allocated = allocations.reduce(
    (sum, allocation) => sum + allocation.retired_microdollars + allocation.consumed_microdollars,
    0
  );
  const outstandingDebt = Math.max(
    0,
    -refund.amount_microdollars - refund.retired_microdollars - allocated
  );
  const debtRestored = Math.min(
    outstandingDebt,
    Math.max(0, state.microdollars_used - state.total_microdollars_acquired)
  );
  // Restored lots resume from current usage; debt they cover is consumed explicitly below.
  const baseline = state.microdollars_used;
  const expired = source.expiry_date !== null && new Date(source.expiry_date) <= now;
  const legacyRefund = refund.source_transaction_id === null;
  let amount = legacyRefund
    ? expired
      ? debtRestored
      : -refund.amount_microdollars
    : debtRestored + (expired ? 0 : refund.retired_microdollars);
  let legacyRestored = 0;
  const restored: RestoredExposure[] = [];
  if (!expired && refund.retired_microdollars > 0) {
    await tx
      .update(credit_transactions)
      .set({
        retired_microdollars: Math.max(
          0,
          source.retired_microdollars - refund.retired_microdollars
        ),
        expiration_baseline_microdollars_used: baseline,
      })
      .where(eq(credit_transactions.id, source.id));
    restored.push({
      lotId: source.id,
      exposure: refund.retired_microdollars,
      provenance: provenance(source),
    });
  }
  for (const allocation of allocations) {
    const principal = allocation.retired_microdollars + allocation.consumed_microdollars;
    const [repaymentSource] = allocation.source_transaction_id
      ? await tx
          .select()
          .from(credit_transactions)
          .where(eq(credit_transactions.id, allocation.source_transaction_id))
          .limit(1)
      : [];
    const repaymentExpired =
      repaymentSource?.expiry_date !== null &&
      repaymentSource?.expiry_date !== undefined &&
      new Date(repaymentSource.expiry_date) <= now;
    if (repaymentExpired) continue;
    const restorationId = crypto.randomUUID();
    if (repaymentSource) {
      await tx
        .update(credit_transactions)
        .set({
          retired_microdollars: Math.max(
            0,
            repaymentSource.retired_microdollars - allocation.retired_microdollars
          ),
          consumed_microdollars: Math.max(
            0,
            repaymentSource.consumed_microdollars - allocation.consumed_microdollars
          ),
          expiration_baseline_microdollars_used: baseline,
        })
        .where(eq(credit_transactions.id, repaymentSource.id));
      restored.push({
        lotId: repaymentSource.id,
        exposure: principal,
        provenance: provenance(repaymentSource),
      });
    } else {
      legacyRestored += principal;
      restored.push({ lotId: restorationId, exposure: principal, provenance: LEGACY_PROVENANCE });
    }
    await tx.insert(credit_transactions).values({
      id: restorationId,
      kilo_user_id: source.kilo_user_id,
      organization_id: source.organization_id,
      source_transaction_id: allocation.id,
      ...(repaymentSource
        ? provenance(repaymentSource)
        : { paid_credit_policy: 'legacy', expiry_date: null }),
      amount_microdollars: repaymentSource ? 0 : principal,
      retired_microdollars: repaymentSource ? allocation.retired_microdollars : 0,
      consumed_microdollars: repaymentSource ? allocation.consumed_microdollars : 0,
      is_free: true,
      credit_category: `refund_debt_restored:${allocation.id}`,
      description: 'Refund repayment allocation restored',
      created_at: now.toISOString(),
      original_baseline_microdollars_used: state.microdollars_used,
      expiration_baseline_microdollars_used: baseline,
    });
    amount += principal;
  }
  const id = crypto.randomUUID();
  await tx.insert(credit_transactions).values({
    id,
    kilo_user_id: source.kilo_user_id,
    organization_id: source.organization_id,
    created_by_kilo_user_id: params.actorId,
    source_transaction_id: refund.id,
    ...provenance(source),
    amount_microdollars: amount - legacyRestored,
    refund_principal_microdollars: -(
      refund.refund_principal_microdollars ?? refund.amount_microdollars
    ),
    retired_microdollars: amount - legacyRestored,
    consumed_microdollars: source.consumed_microdollars,
    is_free: source.is_free,
    credit_category: params.creditCategory,
    check_category_uniqueness: true,
    description: params.description,
    created_at: now.toISOString(),
    original_baseline_microdollars_used: state.microdollars_used,
    expiration_baseline_microdollars_used: baseline,
  });
  const untracked = amount - debtRestored - restored.reduce((sum, lot) => sum + lot.exposure, 0);
  if (untracked > 0)
    restored.push({ lotId: null, exposure: untracked, provenance: LEGACY_PROVENANCE });
  await absorbRemainingDebt(tx, {
    owner: params.owner,
    holder: source,
    restored,
    debtMicrodollars: Math.max(
      0,
      state.microdollars_used - state.total_microdollars_acquired - debtRestored
    ),
    usedMicrodollars: state.microdollars_used,
    now,
  });
  await moveBalance(tx, params.owner, amount);
  await refreshExpirationPointer(tx, params.owner);
  return { wasInserted: true, creditTransactionId: id, amountMicrodollars: amount };
}

export async function retireCreditBalance(
  tx: DrizzleTransaction,
  params: {
    owner: CreditOwner;
    actorId: string;
    creditCategory: string;
    description: string;
    amountMicrodollars?: number;
    now?: Date;
  }
): Promise<number> {
  const state = await reconcileCreditExpirationsInTransaction(
    params.owner,
    tx,
    params.now ?? new Date()
  );
  const allocations = await normalizeCreditLots(tx, params.owner, state);
  const balance =
    params.amountMicrodollars ??
    Math.max(0, state.total_microdollars_acquired - state.microdollars_used);
  if (!Number.isSafeInteger(balance) || balance < 0)
    throw new Error('Invalid credit retirement amount');
  let retirementRemaining = Math.min(
    balance,
    Math.max(0, state.total_microdollars_acquired - state.microdollars_used)
  );
  let remaining = balance;
  for (const allocation of allocations) {
    const amount = Math.min(remaining, retirementRemaining, allocation.remaining_microdollars);
    if (amount <= 0) continue;
    const source = allocation.transaction;
    await tx
      .update(credit_transactions)
      .set({
        retired_microdollars: (source.retired_microdollars ?? 0) + amount,
      })
      .where(eq(credit_transactions.id, source.id));
    await tx.insert(credit_transactions).values({
      kilo_user_id: params.actorId,
      organization_id: params.owner.type === 'organization' ? params.owner.id : null,
      ...(params.owner.type === 'user' ? { kilo_user_id: params.owner.id } : {}),
      created_by_kilo_user_id: params.actorId,
      source_transaction_id: source.id,
      ...provenance(source),
      amount_microdollars: -amount,
      retired_microdollars: amount,
      is_free: true,
      credit_category: params.creditCategory,
      description: params.description,
      original_baseline_microdollars_used: state.microdollars_used,
    });
    remaining -= amount;
    retirementRemaining -= amount;
  }
  if (remaining > 0) {
    await tx.insert(credit_transactions).values({
      kilo_user_id: params.owner.type === 'user' ? params.owner.id : params.actorId,
      organization_id: params.owner.type === 'organization' ? params.owner.id : null,
      created_by_kilo_user_id: params.actorId,
      paid_credit_policy: 'legacy',
      amount_microdollars: -remaining,
      is_free: true,
      credit_category: params.creditCategory,
      description: params.description,
      original_baseline_microdollars_used: state.microdollars_used,
    });
  }
  await moveBalance(tx, params.owner, -balance);
  await refreshExpirationPointer(tx, params.owner);
  return balance;
}

export async function transferCreditLots(
  tx: DrizzleTransaction,
  params: {
    from: CreditOwner;
    to: CreditOwner;
    actorId: string;
    amountMicrodollars: number;
    outgoingCategory: string;
    incomingCategory: string;
    outgoingDescription: string;
    incomingDescription: string;
    now?: Date;
  }
): Promise<void> {
  if (params.from.type === params.to.type && params.from.id === params.to.id)
    throw new Error('Cannot transfer credits to the same owner');
  const states = await lockCreditOwners(tx, [params.from, params.to], params.now ?? new Date());
  const from = states.get(`${params.from.type}:${params.from.id}`);
  const to = states.get(`${params.to.type}:${params.to.id}`);
  if (!from || !to) throw new Error('Credit owner not found');
  const amount = params.amountMicrodollars;
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > from.total_microdollars_acquired - from.microdollars_used
  ) {
    throw new Error('The total amount to distribute exceeds the available balance.');
  }
  const allocations = await normalizeCreditLots(tx, params.from, from);
  let remaining = amount;
  let targetAcquired = to.total_microdollars_acquired;
  const insertPair = async (moved: number, source?: CreditTransaction) => {
    const outgoingId = crypto.randomUUID();
    const metadata = source
      ? provenance(source)
      : { paid_credit_policy: 'legacy', credit_source: null, expiry_date: null };
    await tx.insert(credit_transactions).values({
      id: outgoingId,
      kilo_user_id: params.from.type === 'user' ? params.from.id : params.actorId,
      organization_id: params.from.type === 'organization' ? params.from.id : null,
      created_by_kilo_user_id: params.actorId,
      ...metadata,
      source_transaction_id: source?.id,
      amount_microdollars: -moved,
      retired_microdollars: moved,
      is_free: true,
      credit_category: params.outgoingCategory,
      description: params.outgoingDescription,
      original_baseline_microdollars_used: from.microdollars_used,
    });
    const [incoming] = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: params.to.type === 'user' ? params.to.id : params.actorId,
        organization_id: params.to.type === 'organization' ? params.to.id : null,
        created_by_kilo_user_id: params.actorId,
        ...metadata,
        source_transaction_id: source?.id ?? outgoingId,
        amount_microdollars: moved,
        is_free: true,
        credit_category: params.incomingCategory,
        description: params.incomingDescription,
        original_baseline_microdollars_used: to.microdollars_used,
        expiration_baseline_microdollars_used: Math.min(to.microdollars_used, targetAcquired),
      })
      .returning({ id: credit_transactions.id });
    await recordRefundDebtRepayment(tx, {
      owner: params.to,
      transactionId: incoming.id,
      priorAcquired: targetAcquired,
      priorUsed: to.microdollars_used,
      amountMicrodollars: moved,
    });
    targetAcquired += moved;
  };
  for (const allocation of allocations) {
    const moved = Math.min(remaining, allocation.remaining_microdollars);
    if (moved <= 0) continue;
    const source = allocation.transaction;
    await tx
      .update(credit_transactions)
      .set({
        retired_microdollars: (source.retired_microdollars ?? 0) + moved,
      })
      .where(eq(credit_transactions.id, source.id));
    await insertPair(moved, source);
    remaining -= moved;
  }
  if (remaining > 0) await insertPair(remaining);
  await moveBalance(tx, params.from, -amount);
  await moveBalance(tx, params.to, amount);
  await refreshExpirationPointer(tx, params.from);
  await refreshExpirationPointer(tx, params.to);
}
