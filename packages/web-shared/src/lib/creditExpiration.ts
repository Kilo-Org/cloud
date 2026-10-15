import type { CreditTransaction, User } from '@kilocode/db/schema';
import { credit_transactions as creditTransactionsTable, organizations } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { eq, and, gt, isNull, isNotNull, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import {
  computeExpiration,
  reconcileCreditExpirationsInTransaction,
  type ExpiringTransaction,
  type EntityForExpiration,
} from '@kilocode/db/credit-expiration';

type DbOrTx = typeof db | DrizzleTransaction;

export type CreditTransactionForBlocks = ExpiringTransaction &
  Pick<CreditTransaction, 'credit_category' | 'original_transaction_id' | 'created_at'>;

export type UserForExpiration = EntityForExpiration;
export type UserForLocalExpiration = Pick<
  User,
  | 'id'
  | 'microdollars_used'
  | 'next_credit_expiration_at'
  | 'updated_at'
  | 'total_microdollars_acquired'
>;

export async function fetchExpiringTransactions(userId: string, fromDb: DbOrTx = db) {
  const expiredCredits = alias(creditTransactionsTable, 'expired_credits');

  // Fetch ALL transactions with expiry dates (including future ones) for baseline adjustment
  // Use LEFT JOIN to exclude transactions that have already been processed (have a credits_expired entry)
  // Match on original_transaction_id (preferred) OR orb_credit_block_id (legacy)
  return await fromDb
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
        eq(expiredCredits.kilo_user_id, userId),
        inArray(expiredCredits.credit_category, [
          'credits_expired',
          'orb_credit_expired',
          'orb_credit_voided',
        ]),
        eq(expiredCredits.original_transaction_id, creditTransactionsTable.id)
      )
    )
    .where(
      and(
        eq(creditTransactionsTable.kilo_user_id, userId),
        gt(creditTransactionsTable.amount_microdollars, 0),
        isNotNull(creditTransactionsTable.expiry_date),
        isNull(expiredCredits.id), // Not already processed
        isNull(creditTransactionsTable.organization_id)
      )
    );
}

type ExpirationBalanceState = Pick<
  UserForLocalExpiration,
  'total_microdollars_acquired' | 'microdollars_used' | 'next_credit_expiration_at'
>;

function refreshedExpirationState(
  snapshot: ExpirationBalanceState,
  current: ExpirationBalanceState
): ExpirationBalanceState | null {
  const snapshotExpiry = snapshot.next_credit_expiration_at;
  const currentExpiry = current.next_credit_expiration_at;
  const sameExpiry =
    snapshotExpiry === null || currentExpiry === null
      ? snapshotExpiry === currentExpiry
      : new Date(snapshotExpiry).getTime() === new Date(currentExpiry).getTime();
  if (
    sameExpiry &&
    current.total_microdollars_acquired === snapshot.total_microdollars_acquired &&
    current.microdollars_used === snapshot.microdollars_used
  ) {
    return null;
  }
  return {
    total_microdollars_acquired: current.total_microdollars_acquired,
    microdollars_used: current.microdollars_used,
    next_credit_expiration_at: currentExpiry,
  };
}

/**
 * Process local expirations for a migrated user (not in legacy Orb system).
 * Uses idempotency checks to prevent double-processing by excluding transactions
 * that already have a credits_expired entry.
 *
 * Returns null when the caller's snapshot is already current, otherwise the refreshed
 * balance fields and expiration pointer.
 */
export async function processLocalExpirations(
  user: UserForLocalExpiration,
  now: Date
): Promise<ExpirationBalanceState | null> {
  return await db.transaction(async tx =>
    refreshedExpirationState(
      user,
      await reconcileCreditExpirationsInTransaction({ type: 'user', id: user.id }, tx, now)
    )
  );
}

/**
 * Computes the total unused credit amount (in microdollars) that will expire at the
 * next expiration date, given a list of unprocessed expiring transactions.
 *
 * Uses the same expiry-claiming algorithm as computeExpiration to ensure the
 * returned amount is consistent with processOrganizationExpirations.
 *
 * Returns null when there is no upcoming expiration or when all credits expiring
 * at that date have already been consumed.
 */
export function computeNextExpirationAmount(
  transactions: ExpiringTransaction[],
  entity: EntityForExpiration,
  nextExpirationAt: string | null
): number | null {
  if (!nextExpirationAt) return null;

  const result = computeExpiration(transactions, entity, new Date(nextExpirationAt), 'system');

  const totalExpiring = result.newTransactions.reduce(
    (sum, t) => sum + -(t.amount_microdollars ?? 0),
    0
  );

  return totalExpiring > 0 ? totalExpiring : null;
}

export async function fetchExpiringTransactionsForOrganization(
  organizationId: string,
  fromDb: DbOrTx = db
) {
  const expiredCredits = alias(creditTransactionsTable, 'expired_credits');

  return await fromDb
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
      kilo_user_id: creditTransactionsTable.kilo_user_id,
    })
    .from(creditTransactionsTable)
    .leftJoin(
      expiredCredits,
      and(
        eq(expiredCredits.organization_id, organizationId),
        eq(expiredCredits.credit_category, 'credits_expired'),
        eq(expiredCredits.original_transaction_id, creditTransactionsTable.id)
      )
    )
    .where(
      and(
        eq(creditTransactionsTable.organization_id, organizationId),
        isNotNull(creditTransactionsTable.expiry_date),
        gt(creditTransactionsTable.amount_microdollars, 0),
        isNull(expiredCredits.id)
      )
    );
}

export type OrganizationForExpiration = {
  id: string;
  microdollars_used: number;
  next_credit_expiration_at: string | null;
  total_microdollars_acquired: number;
};

export type OrganizationExpirationState = Pick<
  OrganizationForExpiration,
  'microdollars_used' | 'total_microdollars_acquired' | 'next_credit_expiration_at'
>;

type OpenOrganizationCreditLot = ExpiringTransaction & {
  organization_id: string;
};

async function fetchOpenCreditLotsForOrganizations(
  organizationIds: string[],
  expiryCondition: SQL
): Promise<OpenOrganizationCreditLot[]> {
  if (organizationIds.length === 0) return [];

  const expiredCredits = alias(creditTransactionsTable, 'expired_credits');
  return await db
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
      organization_id: sql<string>`${creditTransactionsTable.organization_id}`,
    })
    .from(creditTransactionsTable)
    .leftJoin(
      expiredCredits,
      and(
        eq(expiredCredits.organization_id, creditTransactionsTable.organization_id),
        eq(expiredCredits.credit_category, 'credits_expired'),
        eq(expiredCredits.original_transaction_id, creditTransactionsTable.id)
      )
    )
    .where(
      and(
        inArray(creditTransactionsTable.organization_id, organizationIds),
        gt(creditTransactionsTable.amount_microdollars, 0),
        expiryCondition,
        isNull(expiredCredits.id)
      )
    );
}

/**
 * Processes expiration snapshots for many organizations with set-based database writes.
 * The returned map contains current persisted state for every requested organization that
 * still exists, including organizations that had nothing due or lost an optimistic race.
 */
export async function processOrganizationExpirationsBatch(
  organizationSnapshots: OrganizationForExpiration[],
  now: Date,
  remainingConflictRetries = 2
): Promise<Map<string, OrganizationExpirationState>> {
  const organizationsById = new Map(organizationSnapshots.map(org => [org.id, org]));
  const organizationIds = [...organizationsById.keys()];
  if (organizationIds.length === 0) return new Map();

  const expiringLots = await fetchOpenCreditLotsForOrganizations(
    organizationIds,
    isNotNull(creditTransactionsTable.expiry_date)
  );
  const dueOrganizationIds = [
    ...new Set(
      expiringLots
        .filter(lot => lot.expiry_date !== null && new Date(lot.expiry_date) <= now)
        .map(lot => lot.organization_id)
    ),
  ];
  const openTransactions = [
    ...expiringLots,
    ...(await fetchOpenCreditLotsForOrganizations(
      dueOrganizationIds,
      isNull(creditTransactionsTable.expiry_date)
    )),
  ];
  const transactionsByOrganizationId = Map.groupBy(
    openTransactions,
    transaction => transaction.organization_id
  );
  const prepared = organizationIds.flatMap(organizationId => {
    const org = organizationsById.get(organizationId);
    if (!org) return [];

    const transactions = transactionsByOrganizationId.get(organizationId) ?? [];
    const expirationResult = computeExpiration(transactions, org, now, 'system');
    const expiredTransactionIds = new Set(
      expirationResult.newTransactions.map(transaction => transaction.original_transaction_id)
    );
    const nextExpirationAt =
      transactions
        .filter(transaction => !expiredTransactionIds.has(transaction.id))
        .map(transaction => transaction.expiry_date)
        .filter(expiryDate => expiryDate !== null)
        .sort()[0] ?? null;
    const nextExpirationChanged =
      nextExpirationAt === null
        ? org.next_credit_expiration_at !== null
        : org.next_credit_expiration_at === null ||
          new Date(nextExpirationAt).getTime() !==
            new Date(org.next_credit_expiration_at).getTime();
    if (expirationResult.newTransactions.length === 0 && !nextExpirationChanged) return [];

    const totalExpired = expirationResult.newTransactions.reduce(
      (sum, transaction) => sum + (transaction.amount_microdollars ?? 0),
      0
    );

    return [
      {
        org,
        expirationResult,
        nextExpirationAt,
        totalExpired,
        totalMicrodollarsAcquired: org.total_microdollars_acquired + totalExpired,
      },
    ];
  });

  const currentStates = await db.transaction(async tx => {
    let updatedOrganizationIds = new Set<string>();
    if (prepared.length > 0) {
      const organizationUpdates = prepared.map(item => ({
        id: item.org.id,
        expected_total_microdollars_acquired: item.org.total_microdollars_acquired,
        expected_microdollars_used: item.org.microdollars_used,
        expected_next_credit_expiration_at: item.org.next_credit_expiration_at,
        total_microdollars_acquired: item.totalMicrodollarsAcquired,
        next_credit_expiration_at: item.nextExpirationAt,
        total_expired: item.totalExpired,
      }));
      const updatedOrganizations = await tx.execute<{ id: string }>(sql`
        UPDATE ${organizations} AS organization
        SET
          total_microdollars_acquired = update_values.total_microdollars_acquired,
          next_credit_expiration_at = update_values.next_credit_expiration_at,
          microdollars_balance = organization.microdollars_balance + update_values.total_expired
        FROM jsonb_to_recordset(${JSON.stringify(organizationUpdates)}::jsonb) AS update_values(
          id uuid,
          expected_total_microdollars_acquired bigint,
          expected_microdollars_used bigint,
          expected_next_credit_expiration_at timestamptz,
          total_microdollars_acquired bigint,
          next_credit_expiration_at timestamptz,
          total_expired bigint
        )
        WHERE organization.id = update_values.id
          AND organization.total_microdollars_acquired = update_values.expected_total_microdollars_acquired
          AND organization.microdollars_used = update_values.expected_microdollars_used
          AND organization.next_credit_expiration_at IS NOT DISTINCT FROM update_values.expected_next_credit_expiration_at
        RETURNING organization.id
      `);
      updatedOrganizationIds = new Set(updatedOrganizations.rows.map(row => row.id));

      const expirationTransactions = prepared.flatMap(item =>
        updatedOrganizationIds.has(item.org.id)
          ? item.expirationResult.newTransactions.map(transaction => ({
              ...transaction,
              organization_id: item.org.id,
            }))
          : []
      );
      if (expirationTransactions.length > 0) {
        await tx.insert(creditTransactionsTable).values(expirationTransactions);
      }

      const baselineUpdates = prepared.flatMap(item =>
        updatedOrganizationIds.has(item.org.id)
          ? [...item.expirationResult.newBaselines].map(([id, baseline]) => ({ id, baseline }))
          : []
      );
      if (baselineUpdates.length > 0) {
        await tx.execute(sql`
          UPDATE ${creditTransactionsTable} AS credit_transaction
          SET expiration_baseline_microdollars_used = update_values.baseline
          FROM jsonb_to_recordset(${JSON.stringify(baselineUpdates)}::jsonb) AS update_values(
            id uuid,
            baseline bigint
          )
          WHERE credit_transaction.id = update_values.id
        `);
      }
    }

    const currentOrganizations = await tx
      .select({
        id: organizations.id,
        microdollars_used: organizations.microdollars_used,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
      })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds));

    return new Map(
      currentOrganizations.map(org => [
        org.id,
        {
          microdollars_used: org.microdollars_used,
          total_microdollars_acquired: org.total_microdollars_acquired,
          next_credit_expiration_at: org.next_credit_expiration_at,
        },
      ])
    );
  });

  const retrySnapshots = prepared.flatMap(item => {
    const current = currentStates.get(item.org.id);
    if (
      !current ||
      !current.next_credit_expiration_at ||
      new Date(current.next_credit_expiration_at) > now
    ) {
      return [];
    }
    return [{ id: item.org.id, ...current }];
  });
  if (retrySnapshots.length === 0) return currentStates;
  if (remainingConflictRetries === 0) {
    sentryLogger('processOrganizationExpirationsBatch', 'error')(
      'optimistic concurrency retries exhausted',
      { organization_ids: retrySnapshots.map(org => org.id) }
    );
    return currentStates;
  }

  const retriedStates = await processOrganizationExpirationsBatch(
    retrySnapshots,
    now,
    remainingConflictRetries - 1
  );
  for (const [organizationId, state] of retriedStates) currentStates.set(organizationId, state);
  return currentStates;
}

export async function processOrganizationExpirations(
  org: OrganizationForExpiration,
  now: Date
): Promise<OrganizationExpirationState | null> {
  return await db.transaction(async tx =>
    refreshedExpirationState(
      org,
      await reconcileCreditExpirationsInTransaction({ type: 'organization', id: org.id }, tx, now)
    )
  );
}
