import type { credit_transactions, CreditTransaction } from '@kilocode/db/schema';
import {
  credit_transactions as creditTransactionsTable,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { eq, and, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

type DbOrTx = typeof db | DrizzleTransaction;

export type ExpiringTransaction = Pick<
  CreditTransaction,
  | 'id'
  | 'amount_microdollars'
  | 'expiration_baseline_microdollars_used'
  | 'expiry_date'
  | 'description'
  | 'is_free'
>;

export type CreditTransactionForBlocks = ExpiringTransaction &
  Pick<CreditTransaction, 'credit_category' | 'original_transaction_id' | 'created_at'>;

export type EntityForExpiration = { id: string; microdollars_used: number };
export type CreditExpirationState = {
  microdollars_used: number;
  total_microdollars_acquired: number;
  next_credit_expiration_at: string | null;
};

type ExpirationResult = {
  newTransactions: (typeof credit_transactions.$inferInsert)[];
  newBaselines: Map<CreditTransaction['id'], number>;
};
/**
 * Computes the expiration of credits for an entity (user or organization).
 *
 * **Core idea:** Each credit can only be claimed once. To keep the algorithm
 * simple and incrementally runnable, each transaction's state is a consecutive
 * range of usage (from baseline to baseline+amount). This means that transactions
 * can have mutually contradictory claims since they can overlap. This overlap is
 * resolved one by one at expiration time. When an earlier-expiring credit claims
 * some usage, we "swap" that usage out of later credits by raising their baselines.
 * When the later credits expire, the right amount expires.
 *
 * **How it works:** Process transactions in expiry order. Each claims usage from
 * its baseline up to min(baseline+amount, entity's total usage). When a credit
 * expires and claims usage, raise the baselines of all later credits that overlap
 * with the claimed range. This prevents double-counting while keeping each
 * transaction's state as a simple consecutive range.
 *
 * **Incremental safety:** No lookahead, no local state between loop iterations
 * (newBaselines is exported). The final balance is the same whether run once in
 * bulk or incrementally over time.
 */

export function computeExpiration(
  transactions: ExpiringTransaction[],
  entity: EntityForExpiration,
  now: Date,
  kilo_user_id: string
): ExpirationResult {
  const newBaselines = new Map<CreditTransaction['id'], number>();
  const newTransactions: (typeof credit_transactions.$inferInsert)[] = [];
  const sortedByExpiry = transactions
    .filter((t): t is ExpiringTransaction & { expiry_date: string } => t.expiry_date != null)
    .sort((a, b) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime());

  for (let currentIndex = 0; currentIndex < sortedByExpiry.length; currentIndex++) {
    const t = sortedByExpiry[currentIndex];
    const isExpired = new Date(t.expiry_date) <= now;
    if (!isExpired) continue;

    const baseline = newBaselines.get(t.id) ?? t.expiration_baseline_microdollars_used ?? 0;
    const transactionEnd = baseline + t.amount_microdollars;
    const usageEnd = Math.min(transactionEnd, entity.microdollars_used);
    const usage = Math.max(0, usageEnd - baseline);
    const expiredAmount = t.amount_microdollars - usage;
    newTransactions.push({
      kilo_user_id,
      amount_microdollars: expiredAmount === 0 ? 0 : -expiredAmount,
      credit_category: 'credits_expired',
      original_transaction_id: t.id,
      description: `Expired: ${t.description ?? ''}`,
      is_free: t.is_free,
      created_at: t.expiry_date,
      original_baseline_microdollars_used: entity.microdollars_used,
    });
    if (usage === 0) continue;
    for (let laterIndex = currentIndex + 1; laterIndex < sortedByExpiry.length; laterIndex++) {
      const otherT = sortedByExpiry[laterIndex];
      const otherBaseline =
        newBaselines.get(otherT.id) ?? otherT.expiration_baseline_microdollars_used ?? 0;
      const consumedOverlap = Math.min(usage, usageEnd - otherBaseline);
      if (consumedOverlap <= 0) continue;
      newBaselines.set(otherT.id, otherBaseline + consumedOverlap);
    }
  }
  return { newTransactions, newBaselines };
}

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
        isNotNull(creditTransactionsTable.expiry_date),
        isNull(expiredCredits.original_transaction_id),
        isNull(creditTransactionsTable.organization_id)
      )
    );
}

async function persistExpiration(
  tx: DrizzleTransaction,
  expirationResult: ExpirationResult,
  organizationId?: string
) {
  const transactions = organizationId
    ? expirationResult.newTransactions.map(transaction => ({
        ...transaction,
        organization_id: organizationId,
      }))
    : expirationResult.newTransactions;
  const insertBatchSize = 1_000;
  for (let offset = 0; offset < transactions.length; offset += insertBatchSize) {
    await tx
      .insert(creditTransactionsTable)
      .values(transactions.slice(offset, offset + insertBatchSize));
  }

  if (expirationResult.newBaselines.size > 0) {
    const baselineUpdates = [...expirationResult.newBaselines].map(([id, baseline]) => ({
      id,
      baseline,
    }));
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

export async function processLocalExpirations(
  userId: string,
  now: Date,
  options: { force?: boolean } = {}
): Promise<CreditExpirationState> {
  // Lazy expiry must use the primary so usage and ledger changes share the owner lock.
  return await db.transaction(async tx => {
    const [user] = await tx
      .select({
        microdollars_used: kilocode_users.microdollars_used,
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .for('update');
    if (!user) throw new Error(`User not found during credit expiration: ${userId}`);
    if (
      !options.force &&
      (!user.next_credit_expiration_at || new Date(user.next_credit_expiration_at) > now)
    ) {
      return user;
    }

    const transactions = await fetchExpiringTransactions(userId, tx);
    const expirationResult = computeExpiration(transactions, { id: userId, ...user }, now, userId);
    const expiredTransactionIds = new Set(
      expirationResult.newTransactions.map(transaction => transaction.original_transaction_id)
    );
    const next_credit_expiration_at =
      transactions
        .filter(transaction => !expiredTransactionIds.has(transaction.id))
        .map(transaction => transaction.expiry_date)
        .filter(expiryDate => expiryDate !== null)
        .sort()[0] ?? null;
    const totalExpired = expirationResult.newTransactions.reduce(
      (sum, transaction) => sum + (transaction.amount_microdollars ?? 0),
      0
    );
    const total_microdollars_acquired = user.total_microdollars_acquired + totalExpired;

    await tx
      .update(kilocode_users)
      .set({ total_microdollars_acquired, next_credit_expiration_at })
      .where(eq(kilocode_users.id, userId));
    await persistExpiration(tx, expirationResult);

    return {
      microdollars_used: user.microdollars_used,
      total_microdollars_acquired,
      next_credit_expiration_at,
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
        isNull(expiredCredits.original_transaction_id)
      )
    );
}

/**
 * Closes out every still-open (unprocessed) expiring credit grant for an
 * organization, inserting `credits_expired` entries for any unclaimed portion.
 *
 * Without this, an admin who nullifies an organization's credits and later
 * re-grants credits with a different expiration date leaves the original
 * grant's row untouched: it still has its original `expiry_date` and no
 * matching `credits_expired` entry, so every downstream "credits expiring
 * soon" computation (the org Balance page's `getCreditBlocks`, and the admin
 * panel's `computeNextExpirationAmount`) keeps counting it, on top of the new
 * grant, forever inflating the total.
 *
 * Must be called inside the same transaction that also nullifies/adjusts the
 * organization's balance, so the closure is atomic with that change.
 *
 * Returns the total microdollars closed out (negative, or 0 if nothing was open).
 */
export async function closeOutExpiringOrganizationCredits(
  organizationId: string,
  microdollars_used: number,
  tx: DrizzleTransaction
): Promise<number> {
  const openTransactions = await fetchExpiringTransactionsForOrganization(organizationId, tx);
  if (openTransactions.length === 0) return 0;

  // Use a far-future "now" so every still-open grant is treated as expired
  // right away, regardless of its actual expiry_date.
  const forceExpireAt = new Date('9999-01-01T00:00:00.000Z');
  const expirationResult = computeExpiration(
    openTransactions,
    { id: organizationId, microdollars_used },
    forceExpireAt,
    'system'
  );

  if (expirationResult.newTransactions.length) {
    await tx.insert(creditTransactionsTable).values(
      expirationResult.newTransactions.map(t => ({
        ...t,
        organization_id: organizationId,
      }))
    );
  }

  for (const [transactionId, newBaseline] of expirationResult.newBaselines) {
    await tx
      .update(creditTransactionsTable)
      .set({ expiration_baseline_microdollars_used: newBaseline })
      .where(eq(creditTransactionsTable.id, transactionId));
  }

  return expirationResult.newTransactions.reduce((sum, t) => sum + (t.amount_microdollars ?? 0), 0);
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

type ExpiringOrganizationTransaction = ExpiringTransaction & {
  organization_id: string;
};

async function fetchExpiringTransactionsForOrganizations(
  organizationIds: string[],
  fromDb: DbOrTx
): Promise<ExpiringOrganizationTransaction[]> {
  if (organizationIds.length === 0) return [];

  const expiredCredits = alias(creditTransactionsTable, 'expired_credits');
  return await fromDb
    .select({
      id: creditTransactionsTable.id,
      amount_microdollars: creditTransactionsTable.amount_microdollars,
      expiration_baseline_microdollars_used:
        creditTransactionsTable.expiration_baseline_microdollars_used,
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
        isNotNull(creditTransactionsTable.expiry_date),
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

  const openTransactions = await fetchExpiringTransactionsForOrganizations(organizationIds, db);
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
        await tx.execute(sql`
          INSERT INTO ${creditTransactionsTable} (
            kilo_user_id,
            amount_microdollars,
            credit_category,
            original_transaction_id,
            description,
            is_free,
            created_at,
            original_baseline_microdollars_used,
            organization_id
          )
          SELECT
            expiration.kilo_user_id,
            expiration.amount_microdollars,
            expiration.credit_category,
            expiration.original_transaction_id,
            expiration.description,
            expiration.is_free,
            expiration.created_at,
            expiration.original_baseline_microdollars_used,
            expiration.organization_id
          FROM jsonb_to_recordset(${JSON.stringify(expirationTransactions)}::jsonb) AS expiration(
            kilo_user_id text,
            amount_microdollars bigint,
            credit_category text,
            original_transaction_id uuid,
            description text,
            is_free boolean,
            created_at timestamptz,
            original_baseline_microdollars_used bigint,
            organization_id uuid
          )
        `);
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
  // Lazy expiry must use the primary so usage and ledger changes share the owner lock.
  return await db.transaction(async tx => {
    const [org] = await tx
      .select({
        microdollars_used: organizations.microdollars_used,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for('update');
    if (!org) throw new Error(`Organization not found during credit expiration: ${organizationId}`);
    if (
      !options.force &&
      (!org.next_credit_expiration_at || new Date(org.next_credit_expiration_at) > now)
    ) {
      return org;
    }

    const transactions = await fetchExpiringTransactionsForOrganization(organizationId, tx);
    const expirationResult = computeExpiration(
      transactions,
      { id: organizationId, ...org },
      now,
      'system'
    );
    const expiredTransactionIds = new Set(
      expirationResult.newTransactions.map(transaction => transaction.original_transaction_id)
    );
    const next_credit_expiration_at =
      transactions
        .filter(transaction => !expiredTransactionIds.has(transaction.id))
        .map(transaction => transaction.expiry_date)
        .filter(expiryDate => expiryDate !== null)
        .sort()[0] ?? null;
    const totalExpired = expirationResult.newTransactions.reduce(
      (sum, transaction) => sum + (transaction.amount_microdollars ?? 0),
      0
    );
    const total_microdollars_acquired = org.total_microdollars_acquired + totalExpired;

    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired,
        next_credit_expiration_at,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${totalExpired}`,
      })
      .where(eq(organizations.id, organizationId));
    await persistExpiration(tx, expirationResult, organizationId);

    return {
      microdollars_used: org.microdollars_used,
      total_microdollars_acquired,
      next_credit_expiration_at,
    };
  });
}
