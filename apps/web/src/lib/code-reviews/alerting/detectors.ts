import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from '@/lib/drizzle';
import { cloud_agent_code_review_gate_syncs, cloud_agent_code_reviews } from '@kilocode/db/schema';
import { CODE_REVIEW_BENIGN_TERMINAL_REASONS } from '@kilocode/db/schema-types';
import {
  ERROR_SPIKE_RATE_THRESHOLD,
  ERROR_SPIKE_WINDOW_MINUTES,
  GATE_SYNC_BACKLOG_SLA_MINUTES,
  SLOW_REVIEW_DURATION_MINUTES,
  SLOW_REVIEW_RATE_THRESHOLD,
  SLOW_REVIEW_WINDOW_MINUTES,
} from './thresholds';

type AlertingDb = Pick<typeof defaultDb, 'execute'>;
type CountValue = string | number | bigint | null | undefined;

export type SlowReviewsAlertDetails = {
  kind: 'slow_reviews';
  rate: number;
  startedCount: number;
  slowCount: number;
  windowMinutes: number;
  durationMinutes: number;
};

export type ErrorSpikeAlertDetails = {
  kind: 'error_spike';
  rate: number;
  startedCount: number;
  errorCount: number;
  windowMinutes: number;
  topReason?: string;
  topReasonCount?: number;
};

export type GateSyncBacklogAlertDetails = {
  kind: 'gate_sync_backlog';
  unsynchronizedCount: number;
  permissionBlockedCount: number;
  oldestUnsyncedAgeMinutes: number;
  slaMinutes: number;
  dominantFailureCode?: string;
  dominantFailureCount?: number;
};

export type CodeReviewAlertDetails =
  | SlowReviewsAlertDetails
  | ErrorSpikeAlertDetails
  | GateSyncBacklogAlertDetails;

export type CodeReviewAlertEvaluation =
  | { tripped: false }
  | { tripped: true; details: CodeReviewAlertDetails };

type SlowReviewsRow = {
  started_count: CountValue;
  slow_count: CountValue;
};

type ErrorSpikeRow = {
  started_count: CountValue;
  error_count: CountValue;
  top_reason: string | null;
  top_reason_count: CountValue;
};

type GateSyncBacklogRow = {
  unsynchronized_count: CountValue;
  permission_blocked_count: CountValue;
  oldest_unsynced_age_minutes: CountValue;
  dominant_failure_code: string | null;
  dominant_failure_count: CountValue;
};

const benignTerminalReasonsSql = sql`(${sql.join(
  CODE_REVIEW_BENIGN_TERMINAL_REASONS.map(reason => sql`${reason}`),
  sql.raw(', ')
)})`;
const systemFailureSql = sql`(
  status IN ('failed', 'interrupted')
  OR (status = 'cancelled' AND terminal_reason IS NOT NULL)
)`;
const modelNotFoundSql = sql`(
  COALESCE(terminal_reason, '') = 'model_not_found'
  OR COALESCE(error_message, '') ILIKE '%model not found%'
)`;

const startedReviewsCteSql = sql`
  started_reviews AS (
    SELECT
      status,
      terminal_reason,
      error_message,
      COALESCE(started_at, updated_at, created_at) AS started_at_effective,
      COALESCE(completed_at, updated_at) AS completed_at_effective
    FROM ${cloud_agent_code_reviews}
    WHERE status NOT IN ('pending', 'queued')
  )
`;

function toNumber(value: CountValue): number {
  if (value === null || value === undefined) return 0;
  return Number(value) || 0;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export async function evaluateSlowReviews(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<SlowReviewsRow>(sql`
    WITH ${startedReviewsCteSql}, windowed AS (
      SELECT *
      FROM started_reviews
      WHERE started_at_effective >= NOW() - (${SLOW_REVIEW_WINDOW_MINUTES} * INTERVAL '1 minute')
    )
    SELECT
      COUNT(*) AS started_count,
      COUNT(*) FILTER (
        WHERE CASE
          WHEN status = 'running'
            THEN NOW() - started_at_effective > (${SLOW_REVIEW_DURATION_MINUTES} * INTERVAL '1 minute')
          ELSE completed_at_effective - started_at_effective > (${SLOW_REVIEW_DURATION_MINUTES} * INTERVAL '1 minute')
        END
      ) AS slow_count
    FROM windowed
  `);

  const row = result.rows[0];
  const startedCount = toNumber(row?.started_count);
  const slowCount = toNumber(row?.slow_count);
  const currentRate = rate(slowCount, startedCount);

  if (startedCount === 0 || currentRate < SLOW_REVIEW_RATE_THRESHOLD) {
    return { tripped: false };
  }

  return {
    tripped: true,
    details: {
      kind: 'slow_reviews',
      rate: currentRate,
      startedCount,
      slowCount,
      windowMinutes: SLOW_REVIEW_WINDOW_MINUTES,
      durationMinutes: SLOW_REVIEW_DURATION_MINUTES,
    },
  };
}

export async function evaluateErrorSpike(database: AlertingDb): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<ErrorSpikeRow>(sql`
    WITH ${startedReviewsCteSql}, windowed AS (
      SELECT *
      FROM started_reviews
      WHERE started_at_effective >= NOW() - (${ERROR_SPIKE_WINDOW_MINUTES} * INTERVAL '1 minute')
    ), top_reason AS (
      SELECT COALESCE(NULLIF(terminal_reason, ''), 'unknown') AS reason, COUNT(*) AS count
      FROM windowed
      WHERE ${systemFailureSql}
        AND COALESCE(terminal_reason, '') NOT IN ${benignTerminalReasonsSql}
        AND NOT ${modelNotFoundSql}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT 1
    )
    SELECT
      COUNT(*) AS started_count,
      COUNT(*) FILTER (
        WHERE ${systemFailureSql}
          AND COALESCE(terminal_reason, '') NOT IN ${benignTerminalReasonsSql}
          AND NOT ${modelNotFoundSql}
      ) AS error_count,
      (SELECT reason FROM top_reason) AS top_reason,
      (SELECT count FROM top_reason) AS top_reason_count
    FROM windowed
  `);

  const row = result.rows[0];
  const startedCount = toNumber(row?.started_count);
  const errorCount = toNumber(row?.error_count);
  const currentRate = rate(errorCount, startedCount);

  if (startedCount === 0 || currentRate < ERROR_SPIKE_RATE_THRESHOLD) {
    return { tripped: false };
  }

  return {
    tripped: true,
    details: {
      kind: 'error_spike',
      rate: currentRate,
      startedCount,
      errorCount,
      windowMinutes: ERROR_SPIKE_WINDOW_MINUTES,
      ...(row?.top_reason ? { topReason: row.top_reason } : {}),
      ...(toNumber(row?.top_reason_count) > 0
        ? { topReasonCount: toNumber(row?.top_reason_count) }
        : {}),
    },
  };
}

export async function evaluateGateSyncBacklog(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<GateSyncBacklogRow>(sql`
    WITH unsynchronized AS (
      SELECT
        ${cloud_agent_code_review_gate_syncs.last_error_code},
        EXTRACT(EPOCH FROM (
          now() - COALESCE(
            ${cloud_agent_code_review_gate_syncs.last_attempted_at},
            ${cloud_agent_code_review_gate_syncs.updated_at},
            ${cloud_agent_code_review_gate_syncs.created_at}
          )
        )) / 60 AS age_minutes
      FROM ${cloud_agent_code_review_gate_syncs}
      INNER JOIN ${cloud_agent_code_reviews}
        ON ${cloud_agent_code_reviews.id} = ${cloud_agent_code_review_gate_syncs.code_review_id}
      WHERE ${cloud_agent_code_reviews.status} IN ('completed', 'failed', 'cancelled')
        AND ${cloud_agent_code_review_gate_syncs.desired_status} IN ('completed', 'failed', 'cancelled')
        AND ${cloud_agent_code_review_gate_syncs.sync_status} IN ('pending', 'retry', 'processing')
        AND (
          COALESCE(
            ${cloud_agent_code_review_gate_syncs.last_attempted_at},
            ${cloud_agent_code_review_gate_syncs.updated_at},
            ${cloud_agent_code_review_gate_syncs.created_at}
          ) < now() - (${GATE_SYNC_BACKLOG_SLA_MINUTES} * INTERVAL '1 minute')
          OR ${cloud_agent_code_review_gate_syncs.last_error_code} = 'permission'
        )
    ), top_failure AS (
      SELECT COALESCE(last_error_code, 'pending') AS code, COUNT(*) AS count
      FROM unsynchronized
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT 1
    )
    SELECT
      COUNT(*) AS unsynchronized_count,
      COUNT(*) FILTER (WHERE last_error_code = 'permission') AS permission_blocked_count,
      COALESCE(MAX(age_minutes), 0) AS oldest_unsynced_age_minutes,
      (SELECT code FROM top_failure) AS dominant_failure_code,
      (SELECT count FROM top_failure) AS dominant_failure_count
    FROM unsynchronized
  `);

  const row = result.rows[0];
  const unsynchronizedCount = toNumber(row?.unsynchronized_count);
  if (unsynchronizedCount === 0) {
    return { tripped: false };
  }

  return {
    tripped: true,
    details: {
      kind: 'gate_sync_backlog',
      unsynchronizedCount,
      permissionBlockedCount: toNumber(row?.permission_blocked_count),
      oldestUnsyncedAgeMinutes: Math.round(toNumber(row?.oldest_unsynced_age_minutes)),
      slaMinutes: GATE_SYNC_BACKLOG_SLA_MINUTES,
      ...(row?.dominant_failure_code ? { dominantFailureCode: row.dominant_failure_code } : {}),
      ...(toNumber(row?.dominant_failure_count) > 0
        ? { dominantFailureCount: toNumber(row?.dominant_failure_count) }
        : {}),
    },
  };
}
