import type { credit_transactions, CreditTransaction } from './schema';
import {
  credit_transactions as creditTransactionsTable,
  kilocode_users,
  organizations,
} from './schema';
import type { WorkerDb } from './client';
import { and, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

type DrizzleTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];
export type EntityForExpiration = { id: string; microdollars_used: number };
export type OrganizationForExpiration = {
  id: string;
  microdollars_used: number;
  next_credit_expiration_at: string | null;
  total_microdollars_acquired: number;
};
export type ExpiringTransaction = Pick<
  CreditTransaction,
  | 'id'
  | 'amount_microdollars'
  | 'expiration_baseline_microdollars_used'
  | 'expiry_date'
  | 'description'
  | 'is_free'
> &
  Partial<
    Pick<
      CreditTransaction,
      | 'consumed_microdollars'
      | 'retired_microdollars'
      | 'paid_credit_policy'
      | 'credit_source'
      | 'source_transaction_id'
    >
  >;
type ExpirationResult = {
  newTransactions: (typeof credit_transactions.$inferInsert)[];
  newBaselines: Map<CreditTransaction['id'], number>;
};
function sortCreditLots<T extends ExpiringTransaction>(transactions: T[]) {
  return transactions
    .filter(transaction => transaction.amount_microdollars > 0)
    .sort((a, b) => {
      const aExpiry = a.expiry_date === null ? Infinity : new Date(a.expiry_date).getTime();
      const bExpiry = b.expiry_date === null ? Infinity : new Date(b.expiry_date).getTime();
      return aExpiry - bExpiry || a.id.localeCompare(b.id);
    });
}

function lotExposure(transaction: ExpiringTransaction) {
  return Math.max(
    0,
    transaction.amount_microdollars -
      (transaction.consumed_microdollars ?? 0) -
      (transaction.retired_microdollars ?? 0)
  );
}

function claimLotUsage(
  sorted: ExpiringTransaction[],
  index: number,
  microdollarsUsed: number,
  baselines: Map<string, number>
) {
  const transaction = sorted[index];
  const baseline =
    baselines.get(transaction.id) ?? transaction.expiration_baseline_microdollars_used ?? 0;
  const usageEnd = Math.min(baseline + lotExposure(transaction), microdollarsUsed);
  const consumed = Math.max(0, usageEnd - baseline);
  for (let laterIndex = index + 1; laterIndex < sorted.length; laterIndex++) {
    const later = sorted[laterIndex];
    const laterBaseline =
      baselines.get(later.id) ?? later.expiration_baseline_microdollars_used ?? 0;
    const overlap = Math.min(consumed, usageEnd - laterBaseline);
    if (overlap > 0) baselines.set(later.id, laterBaseline + overlap);
  }
  return consumed;
}

export function computeCreditLotAllocations<T extends ExpiringTransaction>(
  transactions: T[],
  entity: EntityForExpiration
) {
  const sorted = sortCreditLots(transactions);
  const baselines = new Map<string, number>();
  return sorted.map((transaction, index) => {
    const consumed = claimLotUsage(sorted, index, entity.microdollars_used, baselines);
    return {
      transaction,
      consumed_microdollars: consumed,
      remaining_microdollars: lotExposure(transaction) - consumed,
    };
  });
}

export function computeExpiration(
  transactions: ExpiringTransaction[],
  entity: EntityForExpiration,
  now: Date,
  kilo_user_id: string
): ExpirationResult {
  const newBaselines = new Map<CreditTransaction['id'], number>();
  const newTransactions: (typeof credit_transactions.$inferInsert)[] = [];
  const sorted = sortCreditLots(transactions);
  for (let index = 0; index < sorted.length; index++) {
    const transaction = sorted[index];
    if (transaction.expiry_date === null || new Date(transaction.expiry_date) > now) break;
    const consumed = claimLotUsage(sorted, index, entity.microdollars_used, newBaselines);
    const expired = lotExposure(transaction) - consumed;
    newTransactions.push({
      kilo_user_id,
      amount_microdollars: expired === 0 ? 0 : -expired,
      credit_category: 'credits_expired',
      original_transaction_id: transaction.id,
      description: `Expired: ${transaction.description ?? ''}`,
      is_free: transaction.is_free,
      created_at: transaction.expiry_date,
      original_baseline_microdollars_used: entity.microdollars_used,
      paid_credit_policy: transaction.paid_credit_policy,
      credit_source: transaction.credit_source,
    });
  }
  return { newTransactions, newBaselines };
}
export type CreditOwner = { type: 'user' | 'organization'; id: string };
export type CreditExpirationOwnerState = OrganizationForExpiration;

export async function reconcileCreditExpirationsInTransaction(
  owner: CreditOwner,
  tx: DrizzleTransaction,
  now = new Date()
): Promise<CreditExpirationOwnerState> {
  const table = owner.type === 'user' ? kilocode_users : organizations;
  const [entity] = await tx
    .select({
      id: table.id,
      microdollars_used: table.microdollars_used,
      total_microdollars_acquired: table.total_microdollars_acquired,
      next_credit_expiration_at: table.next_credit_expiration_at,
    })
    .from(table)
    .where(eq(table.id, owner.id))
    .for('no key update');
  if (!entity) throw new Error(`Credit owner not found: ${owner.type}:${owner.id}`);
  const expiredCredits = alias(creditTransactionsTable, 'processed_expiration');
  const ownerCondition =
    owner.type === 'user'
      ? and(
          eq(creditTransactionsTable.kilo_user_id, owner.id),
          isNull(creditTransactionsTable.organization_id)
        )
      : eq(creditTransactionsTable.organization_id, owner.id);
  const loadOpenLots = (expiryCondition: SQL) =>
    tx
      .select({
        id: creditTransactionsTable.id,
        amount_microdollars: creditTransactionsTable.amount_microdollars,
        expiration_baseline_microdollars_used:
          creditTransactionsTable.expiration_baseline_microdollars_used,
        consumed_microdollars: creditTransactionsTable.consumed_microdollars,
        retired_microdollars: creditTransactionsTable.retired_microdollars,
        paid_credit_policy: creditTransactionsTable.paid_credit_policy,
        credit_source: creditTransactionsTable.credit_source,
        expiry_date: creditTransactionsTable.expiry_date,
        description: creditTransactionsTable.description,
        is_free: creditTransactionsTable.is_free,
      })
      .from(creditTransactionsTable)
      .leftJoin(
        expiredCredits,
        and(
          eq(expiredCredits.original_transaction_id, creditTransactionsTable.id),
          inArray(expiredCredits.credit_category, [
            'credits_expired',
            'orb_credit_expired',
            'orb_credit_voided',
          ])
        )
      )
      .where(
        and(
          ownerCondition,
          gt(creditTransactionsTable.amount_microdollars, 0),
          expiryCondition,
          isNull(expiredCredits.id)
        )
      );
  const expiringLots = await loadOpenLots(isNotNull(creditTransactionsTable.expiry_date));
  const somethingDue = expiringLots.some(
    lot => lot.expiry_date !== null && new Date(lot.expiry_date) <= now
  );
  const transactions = somethingDue
    ? [...expiringLots, ...(await loadOpenLots(isNull(creditTransactionsTable.expiry_date)))]
    : expiringLots;
  const result = computeExpiration(
    transactions,
    entity,
    now,
    owner.type === 'user' ? owner.id : 'system'
  );
  const expiredIds = new Set(
    result.newTransactions.map(transaction => transaction.original_transaction_id)
  );
  const nextExpiration =
    transactions
      .filter(transaction => !expiredIds.has(transaction.id))
      .map(transaction => transaction.expiry_date)
      .filter((expiry): expiry is string => expiry !== null)
      .sort()[0] ?? null;
  const adjustment = result.newTransactions.reduce(
    (sum, transaction) => sum + (transaction.amount_microdollars ?? 0),
    0
  );
  const state = {
    ...entity,
    total_microdollars_acquired: entity.total_microdollars_acquired + adjustment,
    next_credit_expiration_at: nextExpiration,
  };
  for (let offset = 0; offset < result.newTransactions.length; offset += 1000) {
    await tx.insert(creditTransactionsTable).values(
      result.newTransactions.slice(offset, offset + 1000).map(transaction => ({
        ...transaction,
        ...(owner.type === 'organization' ? { organization_id: owner.id } : {}),
      }))
    );
  }
  if (result.newBaselines.size > 0) {
    const updates = [...result.newBaselines].map(([id, baseline]) => ({ id, baseline }));
    await tx.execute(sql`
      UPDATE ${creditTransactionsTable} AS credit_transaction
      SET expiration_baseline_microdollars_used = update_values.baseline
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS update_values(
        id uuid,
        baseline bigint
      )
      WHERE credit_transaction.id = update_values.id
    `);
  }
  if (result.newTransactions.length > 0 || entity.next_credit_expiration_at !== nextExpiration) {
    if (owner.type === 'user') {
      await tx
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: state.total_microdollars_acquired,
          next_credit_expiration_at: nextExpiration,
        })
        .where(eq(kilocode_users.id, owner.id));
    } else {
      await tx
        .update(organizations)
        .set({
          total_microdollars_acquired: state.total_microdollars_acquired,
          microdollars_balance: sql`${organizations.microdollars_balance} + ${adjustment}`,
          next_credit_expiration_at: nextExpiration,
        })
        .where(eq(organizations.id, owner.id));
    }
  }
  return state;
}
