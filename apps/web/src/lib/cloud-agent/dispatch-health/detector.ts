import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from '@/lib/drizzle';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';

export const DISPATCH_HEALTH_COHORT_WINDOW_MINUTES = 15;
export const DISPATCH_HEALTH_GRACE_MINUTES = 5;
export const DISPATCH_HEALTH_STUCK_RATE_THRESHOLD = 0.1;
export const DISPATCH_HEALTH_MINIMUM_AFFECTED_SESSIONS = 3;

type DispatchHealthDb = Pick<typeof defaultDb, 'execute'>;
type CountValue = string | number | bigint | null | undefined;

type DispatchHealthAggregateRow = {
  eligible_run_count: CountValue;
  stuck_run_count: CountValue;
  affected_session_count: CountValue;
  oldest_stuck_queued_at: string | Date | null | undefined;
};

export type DispatchHealthAlertDetails = {
  eligibleRunCount: number;
  stuckRunCount: number;
  affectedSessionCount: number;
  stuckRate: number;
  oldestStuckQueuedAt: string;
};

export type DispatchHealthEvaluation =
  | { tripped: false }
  | { tripped: true; details: DispatchHealthAlertDetails };

function toNumber(value: CountValue): number {
  if (value === null || value === undefined) return 0;
  return Number(value) || 0;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export async function evaluateDispatchHealth(
  database: DispatchHealthDb,
  referenceTime?: Date
): Promise<DispatchHealthEvaluation> {
  const referenceTimeSql = referenceTime
    ? sql`${referenceTime.toISOString()}::timestamptz`
    : sql`NOW()`;
  const result = await database.execute<DispatchHealthAggregateRow>(sql`
    SELECT
      COUNT(*) AS eligible_run_count,
      COUNT(*) FILTER (
        WHERE r.status = 'queued'
          AND r.dispatch_accepted_at IS NULL
          AND r.terminal_at IS NULL
      ) AS stuck_run_count,
      COUNT(DISTINCT r.cloud_agent_session_id) FILTER (
        WHERE r.status = 'queued'
          AND r.dispatch_accepted_at IS NULL
          AND r.terminal_at IS NULL
      ) AS affected_session_count,
      MIN(r.queued_at) FILTER (
        WHERE r.status = 'queued'
          AND r.dispatch_accepted_at IS NULL
          AND r.terminal_at IS NULL
      ) AS oldest_stuck_queued_at
    FROM ${cloud_agent_session_runs} AS r
    INNER JOIN ${cloud_agent_sessions} AS s
      ON s.cloud_agent_session_id = r.cloud_agent_session_id
    WHERE r.queued_at >= ${referenceTimeSql} - (${DISPATCH_HEALTH_COHORT_WINDOW_MINUTES} * INTERVAL '1 minute')
      AND r.queued_at < ${referenceTimeSql} - (${DISPATCH_HEALTH_GRACE_MINUTES} * INTERVAL '1 minute')
      AND s.failure_at IS NULL
  `);

  const row = result.rows[0];
  const eligibleRunCount = toNumber(row?.eligible_run_count);
  const stuckRunCount = toNumber(row?.stuck_run_count);
  const affectedSessionCount = toNumber(row?.affected_session_count);
  const stuckRate = rate(stuckRunCount, eligibleRunCount);

  if (
    stuckRate < DISPATCH_HEALTH_STUCK_RATE_THRESHOLD ||
    affectedSessionCount < DISPATCH_HEALTH_MINIMUM_AFFECTED_SESSIONS
  ) {
    return { tripped: false };
  }

  if (row?.oldest_stuck_queued_at === null || row?.oldest_stuck_queued_at === undefined) {
    throw new Error('Dispatch health aggregate omitted the oldest stuck queue timestamp');
  }

  return {
    tripped: true,
    details: {
      eligibleRunCount,
      stuckRunCount,
      affectedSessionCount,
      stuckRate,
      oldestStuckQueuedAt: new Date(row.oldest_stuck_queued_at).toISOString(),
    },
  };
}
