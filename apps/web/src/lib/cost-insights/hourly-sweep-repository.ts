import { sql } from 'drizzle-orm';

import type { CostInsightOwnerCursor, CostInsightRootDatabase } from './repository';

const OWNER_EVALUATION_JOB_NAME = 'owner_evaluation';

type SweepCheckpointRow = {
  cycle_id: string;
  cycle_as_of: string | Date;
  cohort_created_before: string | Date;
  cursor_owner_type: 'user' | 'organization' | null;
  cursor_owner_id: string | null;
  lease_token: string;
};

export type CostInsightHourlySweepLease = {
  leaseToken: string;
  cycleId: string;
  cycleAsOf: string;
  cohortCreatedBefore: string;
  cursor: CostInsightOwnerCursor | null;
};

function normalizeTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cursorFromRow(row: SweepCheckpointRow): CostInsightOwnerCursor | null {
  if (!row.cursor_owner_type || !row.cursor_owner_id) return null;
  return { ownerType: row.cursor_owner_type, ownerId: row.cursor_owner_id };
}

export async function acquireCostInsightHourlySweepLease(
  database: CostInsightRootDatabase,
  options: { asOf: string; leaseSeconds: number }
): Promise<CostInsightHourlySweepLease | null> {
  const leaseToken = crypto.randomUUID();
  const cycleId = crypto.randomUUID();

  return await database.transaction(async tx => {
    await tx.execute(sql`
      INSERT INTO cost_insight_hourly_sweep_checkpoints (job_name)
      VALUES (${OWNER_EVALUATION_JOB_NAME})
      ON CONFLICT (job_name) DO NOTHING
    `);
    const result = await tx.execute<SweepCheckpointRow>(sql`
      UPDATE cost_insight_hourly_sweep_checkpoints
      SET
        cycle_id = COALESCE(cycle_id, ${cycleId}::uuid),
        cycle_as_of = COALESCE(cycle_as_of, ${options.asOf}::timestamptz),
        cohort_created_before = COALESCE(cohort_created_before, CURRENT_TIMESTAMP),
        lease_token = ${leaseToken}::uuid,
        lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => ${options.leaseSeconds}),
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE job_name = ${OWNER_EVALUATION_JOB_NAME}
        AND (lease_token IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
      RETURNING
        cycle_id::text,
        cycle_as_of,
        cohort_created_before,
        cursor_owner_type,
        cursor_owner_id,
        lease_token::text
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      leaseToken: row.lease_token,
      cycleId: row.cycle_id,
      cycleAsOf: normalizeTimestamp(row.cycle_as_of),
      cohortCreatedBefore: normalizeTimestamp(row.cohort_created_before),
      cursor: cursorFromRow(row),
    };
  });
}

export async function advanceCostInsightHourlySweepCursor(
  database: CostInsightRootDatabase,
  leaseToken: string,
  cursor: CostInsightOwnerCursor
): Promise<boolean> {
  const result = await database.execute<{ job_name: string }>(sql`
    UPDATE cost_insight_hourly_sweep_checkpoints
    SET
      cursor_owner_type = ${cursor.ownerType},
      cursor_owner_id = ${cursor.ownerId},
      updated_at = CURRENT_TIMESTAMP
    WHERE job_name = ${OWNER_EVALUATION_JOB_NAME}
      AND lease_token = ${leaseToken}::uuid
    RETURNING job_name
  `);
  return result.rows.length > 0;
}

export async function completeCostInsightHourlySweepCycle(
  database: CostInsightRootDatabase,
  leaseToken: string
): Promise<boolean> {
  const result = await database.execute<{ job_name: string }>(sql`
    UPDATE cost_insight_hourly_sweep_checkpoints
    SET
      cycle_id = NULL,
      cycle_as_of = NULL,
      cohort_created_before = NULL,
      cursor_owner_type = NULL,
      cursor_owner_id = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      started_at = NULL,
      last_completed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE job_name = ${OWNER_EVALUATION_JOB_NAME}
      AND lease_token = ${leaseToken}::uuid
    RETURNING job_name
  `);
  return result.rows.length > 0;
}

export async function releaseCostInsightHourlySweepLease(
  database: CostInsightRootDatabase,
  leaseToken: string
): Promise<void> {
  await database.execute(sql`
    UPDATE cost_insight_hourly_sweep_checkpoints
    SET
      lease_token = NULL,
      lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE job_name = ${OWNER_EVALUATION_JOB_NAME}
      AND lease_token = ${leaseToken}::uuid
  `);
}
