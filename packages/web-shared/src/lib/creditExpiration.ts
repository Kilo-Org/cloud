import type { CreditTransaction } from '@kilocode/db/schema';
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

export type CreditExpirationState = {
  microdollars_used: number;
  total_microdollars_acquired: number;
  next_credit_expiration_at: string | null;
};

export async function fetchExpiringTransactions(userId: string, fromDb: DbOrTx = db) {
  const closures = alias(creditTransactionsTable, 'closures');
  // LIMIT keeps owner and category filters outside the unique-link lookup.
  const expiredCredits = fromDb
    .select({
      original_transaction_id: closures.original_transaction_id,
      kilo_user_id: closures.kilo_user_id,
      credit_category: closures.credit_category,
    })
    .from(closures)
    .where(eq(closures.original_transaction_id, creditTransactionsTable.id))
    .limit(1)
    .as('expired_credits');
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
    .leftJoinLateral(
      expiredCredits,
      and(
        eq(expiredCredits.kilo_user_id, userId),
        inArray(expiredCredits.credit_category, [
          'credits_expired',
          'orb_credit_expired',
          'orb_credit_voided',
        ])
      )
    )
    .where(
      and(
        eq(creditTransactionsTable.kilo_user_id, userId),
        gt(creditTransactionsTable.amount_microdollars, 0),
        isNotNull(creditTransactionsTable.expiry_date),
        isNull(expiredCredits.original_transaction_id),
        isNull(creditTransactionsTable.organization_id)
      )
    );
}

export async function processLocalExpirations(
  userId: string,
  now: Date,
  options: { force?: boolean } = {}
): Promise<CreditExpirationState> {
  return await db.transaction(async tx => {
    const state = await reconcileCreditExpirationsInTransaction(
      { type: 'user', id: userId },
      tx,
      now,
      { onlyIfDue: !options.force }
    );
    return {
      microdollars_used: state.microdollars_used,
      total_microdollars_acquired: state.total_microdollars_acquired,
      next_credit_expiration_at: state.next_credit_expiration_at,
    };
  });
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
  const closures = alias(creditTransactionsTable, 'closures');
  const expiredCredits = fromDb
    .select({
      original_transaction_id: closures.original_transaction_id,
      organization_id: closures.organization_id,
      credit_category: closures.credit_category,
    })
    .from(closures)
    .where(eq(closures.original_transaction_id, creditTransactionsTable.id))
    .limit(1)
    .as('expired_credits');

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
    .leftJoinLateral(
      expiredCredits,
      and(
        eq(expiredCredits.organization_id, organizationId),
        eq(expiredCredits.credit_category, 'credits_expired')
      )
    )
    .where(
      and(
        eq(creditTransactionsTable.organization_id, organizationId),
        isNotNull(creditTransactionsTable.expiry_date),
        gt(creditTransactionsTable.amount_microdollars, 0),
        isNull(expiredCredits.original_transaction_id)
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
      for (let offset = 0; offset < expirationTransactions.length; offset += 1000) {
        await tx
          .insert(creditTransactionsTable)
          .values(expirationTransactions.slice(offset, offset + 1000));
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
  organizationId: string,
  now: Date,
  options: { force?: boolean } = {}
): Promise<CreditExpirationState> {
  return await db.transaction(async tx => {
    const state = await reconcileCreditExpirationsInTransaction(
      { type: 'organization', id: organizationId },
      tx,
      now,
      { onlyIfDue: !options.force }
    );
    return {
      microdollars_used: state.microdollars_used,
      total_microdollars_acquired: state.total_microdollars_acquired,
      next_credit_expiration_at: state.next_credit_expiration_at,
    };
  });
}
