/**
 * Logic for recomputing a user's balance and credit transactions from the source of truth.
 *
 * This module handles the re-calculation of a user's balance based on their credit transactions
 * and usage history, ensuring the denormalized user record matches the ledger.
 */
import { db } from '@/lib/drizzle';
import { kilocode_users, credit_transactions, microdollar_usage, type User } from '@/db/schema';
import { eq, and, isNull, gt, asc } from 'drizzle-orm';
import { type Result, failureResult, successResult } from '@/lib/maybe-result';
import { bulkUpdate } from '@/lib/utils/bulkUpdate';
import { computeExpiration } from '@/lib/creditExpiration';

export type MigrationResult = Result<UserBalanceUpdates, string>;

/**
 * Recompute a single user's balance based on their transaction and usage history.
 *
 * This function:
 * 1. Fetches all credit transactions and usage records.
 * 2. Recomputes the running baseline of usage for each transaction.
 * 3. Calculates the total acquired credits and total usage.
 * 4. Compares the reconstructed balance against the current user record.
 * 5. If there's a discrepancy, calculates an accounting error adjustment.
 * 6. Updates the user record and transaction baselines (unless dryRun is true).
 *
 * Postconditions:
 * - microdollars_used = sum(microdollar_usage)
 * - total_microdollars_acquired = sum(credit_transactions) [including any new adjustment]
 * - All expiring credit transactions have expiration_baseline_microdollars_used set
 */
export async function recomputeUserBalances(args: {
  userId: string;
  dryRun?: boolean;
}): Promise<MigrationResult> {
  const data = await fetchUserBalanceData(args.userId);
  if (!data) return failureResult('User not found');

  const updates = computeUserBalanceUpdates(data);

  if (!args.dryRun) {
    const success = await applyUserBalanceUpdates(updates);
    if (!success) return failureResult('User was modified during recomputation - retry later');
  }

  return successResult(updates);
}

export type UserBalanceUpdates = {
  user: Pick<User, 'id' | 'updated_at' | 'microdollars_used' | 'total_microdollars_acquired'>;
  user_update: Pick<User, 'microdollars_used' | 'total_microdollars_acquired'>;
  accounting_error_mUsd: number;
  updatesForOriginalBaseline: { id: string; baseline: number; db: number | null }[];
  updatesForExpirationBaseline: { id: string; baseline: number; db: number | null }[];
};

async function fetchUserBalanceData(userId: string) {
  const user = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
    columns: {
      id: true,
      updated_at: true,
      microdollars_used: true,
      total_microdollars_acquired: true,
    },
  });

  if (!user) return null;

  const usageRecords = await db
    .select({
      cost: microdollar_usage.cost,
      created_at: microdollar_usage.created_at,
    })
    .from(microdollar_usage)
    .where(
      and(
        eq(microdollar_usage.kilo_user_id, userId),
        gt(microdollar_usage.cost, 0),
        isNull(microdollar_usage.organization_id)
      )
    )
    .orderBy(asc(microdollar_usage.created_at));

  const creditTransactions = await db
    .select({
      id: credit_transactions.id,
      created_at: credit_transactions.created_at,
      expiry_date: credit_transactions.expiry_date,
      amount_microdollars: credit_transactions.amount_microdollars,
      original_baseline_microdollars_used: credit_transactions.original_baseline_microdollars_used,
      expiration_baseline_microdollars_used:
        credit_transactions.expiration_baseline_microdollars_used,
      description: credit_transactions.description,
      is_free: credit_transactions.is_free,
      original_transaction_id: credit_transactions.original_transaction_id,
    })
    .from(credit_transactions)
    .where(
      and(eq(credit_transactions.kilo_user_id, userId), isNull(credit_transactions.organization_id))
    )
    .orderBy(asc(credit_transactions.created_at));

  return { user, usageRecords, creditTransactions };
}

export function computeUserBalanceUpdates(
  data: NonNullable<Awaited<ReturnType<typeof fetchUserBalanceData>>>
) {
  const { user, usageRecords, creditTransactions } = data;

  // Compute total usage AND original baselines in a single pass
  const computedOriginalBaselines = new Map<string, number>();
  let usageIdx = 0;
  let cumulativeUsage = 0;
  for (const txn of creditTransactions) {
    // Advance through usage records that occurred before this transaction
    while (usageIdx < usageRecords.length && usageRecords[usageIdx].created_at < txn.created_at) {
      cumulativeUsage += usageRecords[usageIdx].cost;
      usageIdx++;
    }
    computedOriginalBaselines.set(txn.id, cumulativeUsage);
  }
  // finally also accumulate over usage after the last transaction
  while (usageIdx < usageRecords.length) {
    cumulativeUsage += usageRecords[usageIdx].cost;
    usageIdx++;
  }

  // Use computeExpiration to determine correct expiration baselines.
  // Start with original baselines, then merge in shifts from computeExpiration.
  const expiringTransactions = creditTransactions
    .filter(t => t.expiry_date != null)
    .map(t => ({
      ...t,
      expiration_baseline_microdollars_used: computedOriginalBaselines.get(t.id) ?? 0,
    }));

  // Use the latest expiration event time (max created_at of records with original_transaction_id)
  // This ensures we only replay expirations that have already been processed
  const lastExpirationTime = creditTransactions
    .filter(t => t.original_transaction_id != null)
    .map(t => new Date(t.created_at))
    .reduce((max, d) => (d > max ? d : max), new Date(0));

  const expirationResult = computeExpiration(
    expiringTransactions,
    { id: user.id, microdollars_used: cumulativeUsage },
    lastExpirationTime,
    user.id
  );

  // Merge: original baselines as base, then overwrite with any shifts from computeExpiration
  const computedExpirationBaselines = new Map([
    ...computedOriginalBaselines,
    ...expirationResult.newBaselines,
  ]);

  const updatesForOriginalBaseline = creditTransactions
    .map(t => ({
      id: t.id,
      baseline: computedOriginalBaselines.get(t.id) ?? 0,
      db: t.original_baseline_microdollars_used,
    }))
    .filter(t => t.baseline !== t.db);

  const updatesForExpirationBaseline = creditTransactions
    .filter(t => t.expiry_date != null)
    .map(t => ({
      id: t.id,
      baseline: computedExpirationBaselines.get(t.id) ?? 0,
      db: t.expiration_baseline_microdollars_used,
    }))
    .filter(t => t.baseline !== t.db);

  const new_microdollars_used = cumulativeUsage;
  const credit_transactions_sum = creditTransactions.reduce(
    (acc, txn) => acc + txn.amount_microdollars,
    0
  );
  const current_balance = user.total_microdollars_acquired - user.microdollars_used;
  // We want to preserve the user's current balance (Total - Used) as the target, so:
  const new_total_microdollars_acquired = current_balance + new_microdollars_used;
  const accounting_error_mUsd = new_total_microdollars_acquired - credit_transactions_sum;

  const user_update = {
    microdollars_used: new_microdollars_used,
    total_microdollars_acquired: new_total_microdollars_acquired,
  };

  return {
    user,
    user_update,
    accounting_error_mUsd,
    updatesForOriginalBaseline,
    updatesForExpirationBaseline,
  };
}

async function applyUserBalanceUpdates(updates: UserBalanceUpdates): Promise<boolean> {
  const {
    user,
    user_update,
    accounting_error_mUsd,
    updatesForOriginalBaseline,
    updatesForExpirationBaseline,
  } = updates;

  return await db.transaction(async tx => {
    // Update user record with optimistic concurrency check
    const updateResult = await tx
      .update(kilocode_users)
      .set(user_update)
      .where(
        and(
          eq(kilocode_users.id, user.id),
          eq(kilocode_users.updated_at, user.updated_at),
          eq(kilocode_users.microdollars_used, user.microdollars_used),
          eq(kilocode_users.total_microdollars_acquired, user.total_microdollars_acquired)
        )
      );

    if (updateResult.rowCount === 0) {
      return false; // User was modified, abort
    }

    // Insert accounting error transaction if needed
    if (accounting_error_mUsd !== 0) {
      await tx.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: accounting_error_mUsd,
        is_free: true,
        credit_category: 'accounting_adjustment',
        description: 'Correction to match cached balance during recomputation',
        original_baseline_microdollars_used: user_update.microdollars_used,
      });
    }

    // Update baselines (computed earlier in single pass)
    await bulkUpdate({
      tx,
      table: credit_transactions,
      idColumn: credit_transactions.id,
      valueColumn: credit_transactions.original_baseline_microdollars_used,
      updates: updatesForOriginalBaseline.map(({ id, baseline }) => ({ id, value: baseline })),
    });
    await bulkUpdate({
      tx,
      table: credit_transactions,
      idColumn: credit_transactions.id,
      valueColumn: credit_transactions.expiration_baseline_microdollars_used,
      updates: updatesForExpirationBaseline.map(({ id, baseline }) => ({ id, value: baseline })),
    });

    return true;
  });
}
