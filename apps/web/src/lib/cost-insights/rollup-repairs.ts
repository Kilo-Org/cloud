import {
  getCostInsightUtcHourStart,
  type CostInsightSpendOwner,
} from '@kilocode/db/cost-insights-rollups';
import { sql } from 'drizzle-orm';
import pLimit from 'p-limit';

import type { CostInsightDatabase, CostInsightRootDatabase } from './repository';
import { repairOwnerSpendRollups } from './rollup-maintenance';

const HOUR_MS = 60 * 60 * 1_000;
const REPAIR_CLAIM_LEASE_MINUTES = 5;

export type ClaimedRollupRepairRow = {
  id: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  hour_start: string | Date;
  generation: string | number | bigint;
  claim_token: string;
};

export type CostInsightRollupRepairFailure = {
  owner: CostInsightSpendOwner;
  hourStart: string;
  error: string;
};

export type CostInsightRollupRepairSummary = {
  claimed: number;
  repaired: number;
  failed: CostInsightRollupRepairFailure[];
};

function ownerKey(owner: CostInsightSpendOwner): string {
  return `${owner.type}:${owner.id}`;
}

function ownerFromRow(row: ClaimedRollupRepairRow): CostInsightSpendOwner {
  if (row.owned_by_user_id && !row.owned_by_organization_id) {
    return { type: 'user', id: row.owned_by_user_id };
  }
  if (row.owned_by_organization_id && !row.owned_by_user_id) {
    return { type: 'organization', id: row.owned_by_organization_id };
  }
  throw new Error('Cost Insights rollup repair row has no valid Spend owner.');
}

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function enqueueCostInsightRollupRepair(
  database: CostInsightDatabase,
  params: { usageId: string; owner: CostInsightSpendOwner; occurredAt: string }
): Promise<void> {
  const hourStart = getCostInsightUtcHourStart(params.occurredAt);
  const ownerColumns =
    params.owner.type === 'user'
      ? { ownedByUserId: params.owner.id, ownedByOrganizationId: null }
      : { ownedByUserId: null, ownedByOrganizationId: params.owner.id };
  const ownerExists =
    params.owner.type === 'user'
      ? sql`EXISTS (SELECT 1 FROM kilocode_users WHERE id = ${params.owner.id})`
      : sql`EXISTS (SELECT 1 FROM organizations WHERE id = ${params.owner.id})`;

  const result = await database.execute<{ id: string }>(sql`
    INSERT INTO cost_insight_rollup_repairs AS repair (
      owned_by_user_id,
      owned_by_organization_id,
      usage_id,
      hour_start,
      next_attempt_at
    ) SELECT
      ${ownerColumns.ownedByUserId},
      ${ownerColumns.ownedByOrganizationId},
      ${params.usageId},
      ${hourStart},
      GREATEST(
        CURRENT_TIMESTAMP + INTERVAL '1 minute',
        ${hourStart}::timestamptz + INTERVAL '1 hour 1 minute'
      )
    WHERE ${ownerExists}
    ON CONFLICT (usage_id)
    DO UPDATE SET
      generation = repair.generation + 1,
      next_attempt_at = GREATEST(repair.next_attempt_at, excluded.next_attempt_at),
      claimed_at = NULL,
      claim_token = NULL,
      attempt_count = 0,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `);
  if (result.rows.length > 1)
    throw new Error('Cost Insights rollup repair enqueue was not unique.');
}

export async function acknowledgeCostInsightRollupCapture(
  database: CostInsightDatabase,
  usageId: string
): Promise<boolean> {
  const result = await database.execute<{ usage_id: string }>(sql`
    DELETE FROM cost_insight_rollup_repairs
    WHERE usage_id = ${usageId}
    RETURNING usage_id
  `);
  return result.rows.length === 1;
}

export async function claimPendingCostInsightRollupRepairs(
  database: CostInsightRootDatabase,
  limit: number
): Promise<ClaimedRollupRepairRow[]> {
  const claimToken = crypto.randomUUID();
  const result = await database.execute<ClaimedRollupRepairRow>(sql`
    WITH claimed AS (
      SELECT repair.id
      FROM cost_insight_rollup_repairs repair
      WHERE repair.next_attempt_at <= CURRENT_TIMESTAMP
        AND (
          repair.claimed_at IS NULL
          OR repair.claimed_at <= CURRENT_TIMESTAMP - make_interval(
            mins => ${REPAIR_CLAIM_LEASE_MINUTES}
          )
        )
      ORDER BY repair.attempt_count ASC, repair.next_attempt_at ASC, repair.hour_start ASC, repair.id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE cost_insight_rollup_repairs repair
    SET
      claimed_at = CURRENT_TIMESTAMP,
      claim_token = ${claimToken},
      attempt_count = repair.attempt_count + 1,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM claimed
    WHERE repair.id = claimed.id
    RETURNING
      repair.id,
      repair.owned_by_user_id,
      repair.owned_by_organization_id,
      repair.hour_start,
      repair.generation,
      repair.claim_token
  `);
  return result.rows;
}

export async function completeCostInsightRollupRepair(
  database: CostInsightRootDatabase,
  row: ClaimedRollupRepairRow,
  owner: CostInsightSpendOwner
): Promise<boolean> {
  const ownerColumns =
    owner.type === 'user'
      ? { ownedByUserId: owner.id, ownedByOrganizationId: null }
      : { ownedByUserId: null, ownedByOrganizationId: owner.id };
  const conflictTarget =
    owner.type === 'user'
      ? sql.raw('(owned_by_user_id) WHERE owned_by_organization_id IS NULL')
      : sql.raw('(owned_by_organization_id) WHERE owned_by_user_id IS NULL');
  return database.transaction(async transaction => {
    const result = await transaction.execute<{ id: string }>(sql`
      WITH removed AS (
        DELETE FROM cost_insight_rollup_repairs
        WHERE id = ${row.id}
          AND generation = ${row.generation}
          AND claim_token = ${row.claim_token}
        RETURNING id
      ), dirtied AS (
        INSERT INTO cost_insight_evaluation_dirty_owners AS dirty_owner (
          owned_by_user_id,
          owned_by_organization_id,
          dirty_at,
          next_attempt_at
        )
        SELECT
          ${ownerColumns.ownedByUserId},
          ${ownerColumns.ownedByOrganizationId},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM removed
        ON CONFLICT ${conflictTarget}
        DO UPDATE SET
          generation = dirty_owner.generation + 1,
          dirty_at = CURRENT_TIMESTAMP,
          next_attempt_at = CURRENT_TIMESTAMP,
          claimed_at = NULL,
          claim_token = NULL,
          updated_at = CURRENT_TIMESTAMP
        RETURNING 1
      )
      SELECT id FROM removed CROSS JOIN dirtied
    `);
    return result.rows.length === 1;
  });
}

export async function failCostInsightRollupRepair(
  database: CostInsightRootDatabase,
  row: ClaimedRollupRepairRow,
  error: string
): Promise<void> {
  await database.execute(sql`
    UPDATE cost_insight_rollup_repairs
    SET
      claimed_at = NULL,
      claim_token = NULL,
      next_attempt_at = CURRENT_TIMESTAMP + make_interval(
        mins => LEAST(60, 5 * attempt_count)
      ),
      last_error_redacted = ${safeRepairErrorCode(error)},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}
      AND claim_token = ${row.claim_token}
  `);
}

function safeRepairErrorCode(error: string): string {
  const postgresCode = error.match(/\b[0-9A-Z]{5}\b/)?.[0];
  return postgresCode ? `postgres:${postgresCode}` : 'cost_insight_rollup_repair_failed';
}

export async function listPendingCostInsightRepairOwnerKeys(
  database: CostInsightRootDatabase,
  owners: CostInsightSpendOwner[]
): Promise<Set<string>> {
  if (owners.length === 0) return new Set();
  const predicates = owners.map(owner =>
    owner.type === 'user'
      ? sql`(owned_by_user_id = ${owner.id} AND owned_by_organization_id IS NULL)`
      : sql`(owned_by_organization_id = ${owner.id} AND owned_by_user_id IS NULL)`
  );
  const result = await database.execute<{
    owned_by_user_id: string | null;
    owned_by_organization_id: string | null;
  }>(sql`
    SELECT DISTINCT owned_by_user_id, owned_by_organization_id
    FROM cost_insight_rollup_repairs
    WHERE ${sql.join(predicates, sql` OR `)}
  `);
  return new Set(
    result.rows.map(row => {
      if (row.owned_by_user_id && !row.owned_by_organization_id) {
        return ownerKey({ type: 'user', id: row.owned_by_user_id });
      }
      if (row.owned_by_organization_id && !row.owned_by_user_id) {
        return ownerKey({ type: 'organization', id: row.owned_by_organization_id });
      }
      throw new Error('Cost Insights pending rollup repair has no valid Spend owner.');
    })
  );
}

export async function processPendingCostInsightRollupRepairs(
  database: CostInsightRootDatabase,
  options: { limit?: number; concurrency?: number } = {}
): Promise<CostInsightRollupRepairSummary> {
  const limit = options.limit ?? 2;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('Cost Insights rollup repair limit must be a positive safe integer.');
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, limit));
  const rows = await claimPendingCostInsightRollupRepairs(database, limit);
  const summary: CostInsightRollupRepairSummary = {
    claimed: rows.length,
    repaired: 0,
    failed: [],
  };
  const limitRepair = pLimit(concurrency);

  await Promise.all(
    rows.map(row =>
      limitRepair(async () => {
        const owner = ownerFromRow(row);
        const hourStart = normalizeTimestamp(row.hour_start);
        try {
          await repairOwnerSpendRollups(database, {
            owner,
            startHour: hourStart,
            endHourExclusive: new Date(Date.parse(hourStart) + HOUR_MS).toISOString(),
            maxHours: 1,
          });
          summary.repaired += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const safeError = safeRepairErrorCode(message);
          await failCostInsightRollupRepair(database, row, message);
          summary.failed.push({ owner, hourStart, error: safeError });
        }
      })
    )
  );

  return summary;
}
