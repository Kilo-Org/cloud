/**
 * Logic for recomputing an organization's balance and credit transactions from the source of truth.
 *
 * This module handles the re-calculation of an org's balance based on their credit transactions
 * and usage history, ensuring the denormalized organization record matches the ledger.
 */
import { db } from '@/lib/drizzle';
import {
  organizations,
  credit_transactions,
  microdollar_usage,
  type Organization,
} from '@/db/schema';
import { eq, and, asc, gt } from 'drizzle-orm';
import { type Result, failureResult, successResult } from '@/lib/maybe-result';
import { computeExpiration } from '@/lib/creditExpiration';
import { bulkUpdate } from '@/lib/utils/bulkUpdate';

type OrganizationBalanceUpdates = {
  org: Pick<
    Organization,
    'id' | 'updated_at' | 'microdollars_used' | 'total_microdollars_acquired'
  >;
  org_update: Pick<Organization, 'microdollars_used' | 'total_microdollars_acquired'>;
  accounting_error_mUsd: number;
  updatesForOriginalBaseline: { id: string; baseline: number; db: number | null }[];
  updatesForExpirationBaseline: { id: string; baseline: number; db: number | null }[];
};

export async function recomputeOrganizationBalances(args: {
  organizationId: string;
  dryRun?: boolean;
}): Promise<Result<OrganizationBalanceUpdates, string>> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, args.organizationId),
    columns: {
      id: true,
      updated_at: true,
      microdollars_used: true,
      total_microdollars_acquired: true,
    },
  });

  if (!org) return failureResult('Organization not found');

  // Fetch all org usage records to recompute microdollars_used
  const usageRecords = await db
    .select({
      cost: microdollar_usage.cost,
      created_at: microdollar_usage.created_at,
    })
    .from(microdollar_usage)
    .where(
      and(eq(microdollar_usage.organization_id, args.organizationId), gt(microdollar_usage.cost, 0))
    )
    .orderBy(asc(microdollar_usage.created_at));

  // Fetch all credit transactions for this org
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
    .where(eq(credit_transactions.organization_id, args.organizationId))
    .orderBy(asc(credit_transactions.created_at));

  // Compute total usage AND original baselines in a single pass
  const computedOriginalBaselines = new Map<string, number>();
  let usageIdx = 0;
  let cumulativeUsage = 0;
  for (const txn of creditTransactions) {
    while (usageIdx < usageRecords.length && usageRecords[usageIdx].created_at < txn.created_at) {
      cumulativeUsage += usageRecords[usageIdx].cost;
      usageIdx++;
    }
    computedOriginalBaselines.set(txn.id, cumulativeUsage);
  }
  while (usageIdx < usageRecords.length) {
    cumulativeUsage += usageRecords[usageIdx].cost;
    usageIdx++;
  }

  // Use computeExpiration to determine correct expiration baselines
  const expiringTransactions = creditTransactions
    .filter(t => t.expiry_date != null)
    .map(t => ({
      ...t,
      expiration_baseline_microdollars_used: computedOriginalBaselines.get(t.id) ?? 0,
    }));

  const lastExpirationTime = creditTransactions
    .filter(t => t.original_transaction_id != null)
    .map(t => new Date(t.created_at))
    .reduce((max, d) => (d > max ? d : max), new Date(0));

  const expirationResult = computeExpiration(
    expiringTransactions,
    { id: org.id, microdollars_used: cumulativeUsage },
    lastExpirationTime,
    'system'
  );

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
  const current_balance = org.total_microdollars_acquired - org.microdollars_used;
  const new_total_microdollars_acquired = current_balance + new_microdollars_used;
  const accounting_error_mUsd = new_total_microdollars_acquired - credit_transactions_sum;

  const updates: OrganizationBalanceUpdates = {
    org,
    org_update: {
      microdollars_used: new_microdollars_used,
      total_microdollars_acquired: new_total_microdollars_acquired,
    },
    accounting_error_mUsd,
    updatesForOriginalBaseline,
    updatesForExpirationBaseline,
  };

  if (!args.dryRun) {
    const success = await applyOrganizationBalanceUpdates(updates);
    if (!success)
      return failureResult('Organization was modified during recomputation - retry later');
  }

  return successResult(updates);
}

async function applyOrganizationBalanceUpdates(
  updates: OrganizationBalanceUpdates
): Promise<boolean> {
  return await db.transaction(async tx => {
    const updateResult = await tx
      .update(organizations)
      .set(updates.org_update)
      .where(
        and(
          eq(organizations.id, updates.org.id),
          eq(organizations.updated_at, updates.org.updated_at),
          eq(organizations.microdollars_used, updates.org.microdollars_used),
          eq(organizations.total_microdollars_acquired, updates.org.total_microdollars_acquired)
        )
      );

    if (updateResult.rowCount === 0) return false;

    if (updates.accounting_error_mUsd !== 0) {
      await tx.insert(credit_transactions).values({
        kilo_user_id: 'system',
        organization_id: updates.org.id,
        amount_microdollars: updates.accounting_error_mUsd,
        is_free: true,
        credit_category: 'accounting_adjustment',
        description: 'Correction to match cached balance during recomputation',
        original_baseline_microdollars_used: updates.org_update.microdollars_used,
      });
    }

    await bulkUpdate({
      tx,
      table: credit_transactions,
      idColumn: credit_transactions.id,
      valueColumn: credit_transactions.original_baseline_microdollars_used,
      updates: updates.updatesForOriginalBaseline.map(({ id, baseline }) => ({
        id,
        value: baseline,
      })),
    });
    await bulkUpdate({
      tx,
      table: credit_transactions,
      idColumn: credit_transactions.id,
      valueColumn: credit_transactions.expiration_baseline_microdollars_used,
      updates: updates.updatesForExpirationBaseline.map(({ id, baseline }) => ({
        id,
        value: baseline,
      })),
    });

    return true;
  });
}
