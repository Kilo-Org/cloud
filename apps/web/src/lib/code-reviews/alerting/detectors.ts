import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from '@/lib/drizzle';
import { cloud_agent_code_reviews } from '@kilocode/db/schema';
import { CODE_REVIEW_BENIGN_TERMINAL_REASONS } from '@kilocode/db/schema-types';
import {
  CODE_REVIEW_ALERT_WINDOW_MINUTES,
  ERROR_SPIKE_FRACTION,
  ERROR_SPIKE_MIN_FAILURES,
  FAILURE_RATE_MIN_TERMINAL,
  FAILURE_RATE_THRESHOLD,
  NO_COMPLETIONS_MIN_CREATED,
  STUCK_COUNT_THRESHOLD,
  STUCK_QUEUED_MINUTES,
  STUCK_RUNNING_MINUTES,
} from './thresholds';

type AlertingDb = Pick<typeof defaultDb, 'execute'>;
type CountValue = string | number | bigint | null | undefined;

export type FailureRateAlertDetails = {
  kind: 'failure_rate';
  rate: number;
  total: number;
  failures: number;
  topReason?: string;
  topReasonCount?: number;
};

export type StuckReviewsAlertDetails = {
  kind: 'stuck_reviews';
  queuedCount: number;
  runningCount: number;
};

export type NoCompletionsAlertDetails = {
  kind: 'no_completions';
  createdCount: number;
};

export type ErrorSpikeAlertDetails = {
  kind: 'error_spike';
  reason: string;
  count: number;
  total: number;
  share: number;
};

export type CodeReviewAlertDetails =
  | FailureRateAlertDetails
  | StuckReviewsAlertDetails
  | NoCompletionsAlertDetails
  | ErrorSpikeAlertDetails;

export type CodeReviewAlertEvaluation =
  | { tripped: false }
  | { tripped: true; details: CodeReviewAlertDetails };

type FailureRateRow = {
  terminal_count: CountValue;
  system_failure_count: CountValue;
  top_reason: string | null;
  top_reason_count: CountValue;
};

type StuckReviewsRow = {
  stuck_queued_count: CountValue;
  stuck_running_count: CountValue;
};

type NoCompletionsRow = {
  completed_count: CountValue;
  created_count: CountValue;
};

type ErrorReasonRow = {
  reason: string;
  count: CountValue;
};

const terminalStatusesSql = sql`('completed', 'failed', 'cancelled', 'interrupted')`;
const benignTerminalReasonsSql = sql`(${sql.join(
  CODE_REVIEW_BENIGN_TERMINAL_REASONS.map(reason => sql`${reason}`),
  sql.raw(', ')
)})`;
const systemFailureSql = sql`(
  status IN ('failed', 'interrupted')
  OR (status = 'cancelled' AND terminal_reason IS NOT NULL)
)`;

function toNumber(value: CountValue): number {
  if (value === null || value === undefined) return 0;
  return Number(value) || 0;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export async function evaluateFailureRate(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<FailureRateRow>(sql`
    WITH windowed AS (
      SELECT status, terminal_reason
      FROM ${cloud_agent_code_reviews}
      WHERE created_at >= NOW() - (${CODE_REVIEW_ALERT_WINDOW_MINUTES} * INTERVAL '1 minute')
    ), top_reason AS (
      SELECT COALESCE(NULLIF(terminal_reason, ''), 'unknown') AS reason, COUNT(*) AS count
      FROM windowed
      WHERE ${systemFailureSql}
        AND COALESCE(terminal_reason, '') NOT IN ${benignTerminalReasonsSql}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT 1
    )
    SELECT
      COUNT(*) FILTER (WHERE status IN ${terminalStatusesSql}) AS terminal_count,
      COUNT(*) FILTER (
        WHERE ${systemFailureSql}
          AND COALESCE(terminal_reason, '') NOT IN ${benignTerminalReasonsSql}
      ) AS system_failure_count,
      (SELECT reason FROM top_reason) AS top_reason,
      (SELECT count FROM top_reason) AS top_reason_count
    FROM windowed
  `);

  const row = result.rows[0];
  const total = toNumber(row?.terminal_count);
  const failures = toNumber(row?.system_failure_count);
  const currentRate = rate(failures, total);

  if (total < FAILURE_RATE_MIN_TERMINAL || currentRate <= FAILURE_RATE_THRESHOLD) {
    return { tripped: false };
  }

  return {
    tripped: true,
    details: {
      kind: 'failure_rate',
      rate: currentRate,
      total,
      failures,
      ...(row?.top_reason ? { topReason: row.top_reason } : {}),
      ...(toNumber(row?.top_reason_count) > 0
        ? { topReasonCount: toNumber(row?.top_reason_count) }
        : {}),
    },
  };
}

export async function evaluateStuckReviews(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<StuckReviewsRow>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE status = 'queued'
          AND updated_at < NOW() - (${STUCK_QUEUED_MINUTES} * INTERVAL '1 minute')
      ) AS stuck_queued_count,
      COUNT(*) FILTER (
        WHERE status = 'running'
          AND COALESCE(started_at, updated_at, created_at) < NOW() - (${STUCK_RUNNING_MINUTES} * INTERVAL '1 minute')
      ) AS stuck_running_count
    FROM ${cloud_agent_code_reviews}
    WHERE status IN ('queued', 'running')
  `);

  const row = result.rows[0];
  const queuedCount = toNumber(row?.stuck_queued_count);
  const runningCount = toNumber(row?.stuck_running_count);

  if (queuedCount < STUCK_COUNT_THRESHOLD && runningCount < STUCK_COUNT_THRESHOLD) {
    return { tripped: false };
  }

  return { tripped: true, details: { kind: 'stuck_reviews', queuedCount, runningCount } };
}

export async function evaluateNoCompletions(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<NoCompletionsRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
      COUNT(*) AS created_count
    FROM ${cloud_agent_code_reviews}
    WHERE created_at >= NOW() - (${CODE_REVIEW_ALERT_WINDOW_MINUTES} * INTERVAL '1 minute')
  `);

  const row = result.rows[0];
  const completedCount = toNumber(row?.completed_count);
  const createdCount = toNumber(row?.created_count);

  if (createdCount < NO_COMPLETIONS_MIN_CREATED || completedCount > 0) {
    return { tripped: false };
  }

  return { tripped: true, details: { kind: 'no_completions', createdCount } };
}

export async function evaluateErrorCategorySpike(
  database: AlertingDb
): Promise<CodeReviewAlertEvaluation> {
  const result = await database.execute<ErrorReasonRow>(sql`
    SELECT COALESCE(NULLIF(terminal_reason, ''), 'unknown') AS reason, COUNT(*) AS count
    FROM ${cloud_agent_code_reviews}
    WHERE ${systemFailureSql}
      AND created_at >= NOW() - (${CODE_REVIEW_ALERT_WINDOW_MINUTES} * INTERVAL '1 minute')
      AND COALESCE(terminal_reason, '') NOT IN ${benignTerminalReasonsSql}
    GROUP BY 1
    ORDER BY 2 DESC, 1 ASC
  `);

  const rows = result.rows;
  const total = rows.reduce((sum, row) => sum + toNumber(row.count), 0);
  const topReason = rows[0];

  if (!topReason || total < ERROR_SPIKE_MIN_FAILURES) {
    return { tripped: false };
  }

  const count = toNumber(topReason.count);
  const share = rate(count, total);

  if (share < ERROR_SPIKE_FRACTION) {
    return { tripped: false };
  }

  return {
    tripped: true,
    details: {
      kind: 'error_spike',
      reason: topReason.reason,
      count,
      total,
      share,
    },
  };
}
