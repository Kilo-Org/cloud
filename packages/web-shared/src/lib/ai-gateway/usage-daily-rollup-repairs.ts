import { sql } from 'drizzle-orm';
import pLimit from 'p-limit';

import type { db, DrizzleTransaction } from '@/lib/drizzle';

const DAY_MS = 24 * 60 * 60 * 1_000;
const REPAIR_CLAIM_LEASE_MINUTES = 5;

type UsageDailyRollupDatabase = typeof db | DrizzleTransaction;

export type DailyUsageRollupRepairParams = {
  usageId: string;
  kiloUserId: string;
  organizationId: string | null;
  createdAt: string;
};

export type ClaimedDailyUsageRollupRepair = {
  usage_id: string;
  kilo_user_id: string;
  organization_id: string | null;
  usage_date: string | Date;
  claim_token: string;
};

export type DailyUsageRollupRepairFailure = {
  usageId: string;
  kiloUserId: string;
  organizationId: string | null;
  usageDate: string;
  error: string;
};

export type DailyUsageRollupRepairSummary = {
  claimed: number;
  repaired: number;
  failed: DailyUsageRollupRepairFailure[];
};

function utcUsageDate(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error('Usage daily rollup repair requires a valid timestamp.');
  return date.toISOString().slice(0, 10);
}

function utcDayStart(usageDate: string | Date): string {
  return `${utcUsageDate(usageDate)}T00:00:00.000Z`;
}

function utcDayEndExclusive(usageDate: string | Date): string {
  return new Date(Date.parse(utcDayStart(usageDate)) + DAY_MS).toISOString();
}

function scopePredicate(
  kiloUserId: string,
  organizationId: string | null,
  userColumn: ReturnType<typeof sql.raw>,
  organizationColumn: ReturnType<typeof sql.raw>
) {
  return organizationId === null
    ? sql`${userColumn} = ${kiloUserId} AND ${organizationColumn} IS NULL`
    : sql`${userColumn} = ${kiloUserId} AND ${organizationColumn} = ${organizationId}::uuid`;
}

export async function enqueueDailyUsageRollupRepair(
  database: UsageDailyRollupDatabase,
  params: DailyUsageRollupRepairParams
): Promise<void> {
  const usageDate = utcUsageDate(params.createdAt);
  await database.execute(sql`
    INSERT INTO microdollar_usage_daily_repairs AS repair (
      usage_id,
      kilo_user_id,
      organization_id,
      usage_date,
      next_attempt_at
    ) VALUES (
      ${params.usageId}::uuid,
      ${params.kiloUserId},
      ${params.organizationId}::uuid,
      ${usageDate}::date,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT (usage_id)
    DO UPDATE SET
      next_attempt_at = CURRENT_TIMESTAMP,
      claimed_at = NULL,
      claim_token = NULL,
      attempt_count = 0,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
  `);
}

export async function claimPendingDailyUsageRollupRepairs(
  database: typeof db,
  limit: number
): Promise<ClaimedDailyUsageRollupRepair[]> {
  const claimToken = crypto.randomUUID();
  const result = await database.execute<ClaimedDailyUsageRollupRepair>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT
        repair.usage_id,
        repair.kilo_user_id,
        repair.organization_id,
        repair.usage_date,
        repair.attempt_count,
        repair.next_attempt_at
      FROM microdollar_usage_daily_repairs repair
      WHERE repair.next_attempt_at <= CURRENT_TIMESTAMP
        AND (
          repair.claimed_at IS NULL
          OR repair.claimed_at <= CURRENT_TIMESTAMP - make_interval(mins => ${REPAIR_CLAIM_LEASE_MINUTES})
        )
      ORDER BY repair.attempt_count, repair.next_attempt_at, repair.usage_date, repair.usage_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ), claimed AS (
      SELECT usage_id
      FROM (
        SELECT
          candidate.usage_id,
          row_number() OVER (
            PARTITION BY candidate.kilo_user_id, candidate.organization_id, candidate.usage_date
            ORDER BY candidate.attempt_count, candidate.next_attempt_at, candidate.usage_id
          ) AS key_rank
        FROM candidates candidate
      ) ranked
      WHERE ranked.key_rank = 1
    )
    UPDATE microdollar_usage_daily_repairs repair
    SET
      claimed_at = CURRENT_TIMESTAMP,
      claim_token = ${claimToken}::uuid,
      attempt_count = repair.attempt_count + 1,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM claimed
    WHERE repair.usage_id = claimed.usage_id
    RETURNING
      repair.usage_id,
      repair.kilo_user_id,
      repair.organization_id,
      repair.usage_date,
      repair.claim_token
  `);
  return result.rows;
}

export async function repairClaimedDailyUsageRollup(
  database: typeof db,
  row: ClaimedDailyUsageRollupRepair
): Promise<boolean> {
  const usageDate = utcUsageDate(row.usage_date);
  const dayStart = utcDayStart(usageDate);
  const dayEndExclusive = utcDayEndExclusive(usageDate);
  const dailyScope = scopePredicate(
    row.kilo_user_id,
    row.organization_id,
    sql.raw('daily.kilo_user_id'),
    sql.raw('daily.organization_id')
  );
  const usageScope = scopePredicate(
    row.kilo_user_id,
    row.organization_id,
    sql.raw('usage.kilo_user_id'),
    sql.raw('usage.organization_id')
  );
  const repairScope = scopePredicate(
    row.kilo_user_id,
    row.organization_id,
    sql.raw('repair.kilo_user_id'),
    sql.raw('repair.organization_id')
  );
  const conflictTarget =
    row.organization_id === null
      ? sql.raw('(kilo_user_id, usage_date) WHERE organization_id IS NULL')
      : sql.raw('(kilo_user_id, organization_id, usage_date) WHERE organization_id IS NOT NULL');

  return await database.transaction(
    async transaction => {
      await transaction.execute(sql.raw("SET LOCAL lock_timeout = '2000'"));
      await transaction.execute(sql.raw("SET LOCAL statement_timeout = '5000'"));
      await transaction.execute(sql.raw("SET LOCAL idle_in_transaction_session_timeout = '10000'"));

      const claim = await transaction.execute<{ usage_id: string }>(sql`
        SELECT usage_id
        FROM microdollar_usage_daily_repairs
        WHERE usage_id = ${row.usage_id}::uuid
          AND claim_token = ${row.claim_token}::uuid
        FOR UPDATE
      `);
      if (claim.rows.length !== 1) return false;

      const lock = await transaction.execute<{ acquired: boolean }>(sql`
        SELECT pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended(
            ${`${row.kilo_user_id}:${row.organization_id ?? 'personal'}:${usageDate}`},
            0
          )
        ) AS acquired
      `);
      if (lock.rows[0]?.acquired !== true) return false;

      // Fence completion to repair signals visible in this transaction. A source
      // transaction that commits later retains its unclaimed signal for the next
      // canonical rebuild instead of being acknowledged by this one.
      await transaction.execute(sql`
        UPDATE microdollar_usage_daily_repairs repair
        SET
          claimed_at = CURRENT_TIMESTAMP,
          claim_token = ${row.claim_token}::uuid,
          updated_at = CURRENT_TIMESTAMP
        WHERE ${repairScope}
          AND repair.usage_date = ${usageDate}::date
          AND repair.claim_token IS NULL
      `);

      const canonical = await transaction.execute<{ total: string | number | bigint }>(sql`
        SELECT COALESCE(SUM(usage.cost), 0)::text AS total
        FROM microdollar_usage usage
        WHERE ${usageScope}
          AND usage.created_at >= ${dayStart}::timestamptz
          AND usage.created_at < ${dayEndExclusive}::timestamptz
      `);
      const total = canonical.rows[0]?.total;
      if (total === undefined)
        throw new Error('Daily usage rollup repair returned no canonical total.');

      if (BigInt(total) === BigInt(0)) {
        await transaction.execute(sql`
          DELETE FROM microdollar_usage_daily daily
          WHERE ${dailyScope}
            AND daily.usage_date = ${usageDate}::date
        `);
      } else {
        await transaction.execute(sql`
          INSERT INTO microdollar_usage_daily AS daily (
            kilo_user_id,
            organization_id,
            usage_date,
            total_cost_microdollars
          ) VALUES (
            ${row.kilo_user_id},
            ${row.organization_id}::uuid,
            ${usageDate}::date,
            ${total}::bigint
          )
          ON CONFLICT ${conflictTarget}
          DO UPDATE SET
            total_cost_microdollars = EXCLUDED.total_cost_microdollars,
            updated_at = CURRENT_TIMESTAMP
        `);
      }

      await transaction.execute(sql`
        DELETE FROM microdollar_usage_daily_repairs repair
        WHERE ${repairScope}
          AND repair.usage_date = ${usageDate}::date
          AND repair.claim_token = ${row.claim_token}::uuid
      `);
      return true;
    },
    { isolationLevel: 'repeatable read' }
  );
}

export async function failDailyUsageRollupRepair(
  database: typeof db,
  row: ClaimedDailyUsageRollupRepair,
  error: string
): Promise<void> {
  await database.execute(sql`
    UPDATE microdollar_usage_daily_repairs
    SET
      claimed_at = NULL,
      claim_token = NULL,
      next_attempt_at = CURRENT_TIMESTAMP + make_interval(mins => LEAST(60, 5 * attempt_count)),
      last_error_redacted = ${safeRepairErrorCode(error)},
      updated_at = CURRENT_TIMESTAMP
    WHERE usage_id = ${row.usage_id}::uuid
      AND claim_token = ${row.claim_token}::uuid
  `);
}

function safeRepairErrorCode(error: string): string {
  const postgresCode = error.match(/\b[0-9A-Z]{5}\b/)?.[0];
  return postgresCode ? `postgres:${postgresCode}` : 'daily_usage_rollup_repair_failed';
}

export async function processPendingDailyUsageRollupRepairs(
  database: typeof db,
  options: { limit?: number; concurrency?: number } = {}
): Promise<DailyUsageRollupRepairSummary> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Daily usage rollup repair limit must be a positive safe integer.');
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, limit));
  const rows = await claimPendingDailyUsageRollupRepairs(database, limit);
  const summary: DailyUsageRollupRepairSummary = { claimed: rows.length, repaired: 0, failed: [] };
  const limitRepair = pLimit(concurrency);

  await Promise.all(
    rows.map(row =>
      limitRepair(async () => {
        const usageDate = utcUsageDate(row.usage_date);
        try {
          if (await repairClaimedDailyUsageRollup(database, row)) {
            summary.repaired += 1;
          } else {
            await failDailyUsageRollupRepair(database, row, 'daily_usage_rollup_repair_deferred');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failDailyUsageRollupRepair(database, row, message);
          summary.failed.push({
            usageId: row.usage_id,
            kiloUserId: row.kilo_user_id,
            organizationId: row.organization_id,
            usageDate,
            error: safeRepairErrorCode(message),
          });
        }
      })
    )
  );
  return summary;
}
