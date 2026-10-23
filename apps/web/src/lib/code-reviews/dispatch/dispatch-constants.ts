import { cloud_agent_code_reviews } from '@kilocode/db/schema';
import { sql, type SQL } from 'drizzle-orm';

export const MAX_CONCURRENT_CODE_REVIEWS_PER_ORG = 20;
export const MAX_CONCURRENT_CODE_REVIEWS_PER_FUNDED_USER = 3;
export const MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER = 1;
export const FUNDED_CODE_REVIEW_BALANCE_THRESHOLD_MICRODOLLARS = 5_000_000;

/**
 * Statuses a review can hold while it still has work outstanding.
 *
 * A review in one of these states can still move; the states it can move to are
 * {@link TERMINAL_CODE_REVIEW_STATUSES}. Callers that select or guard on "still
 * in flight" reference this rather than repeating the literals, so adding or
 * renaming a status is a single edit.
 */
export const NON_TERMINAL_CODE_REVIEW_STATUSES = ['pending', 'queued', 'running'] as const;

export function isNonTerminalCodeReviewStatus(status: string): boolean {
  return (NON_TERMINAL_CODE_REVIEW_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses a review holds once it has stopped moving, i.e. the complement of
 * {@link NON_TERMINAL_CODE_REVIEW_STATUSES} among the statuses this app
 * persists.
 *
 * `interrupted` is deliberately absent: it is listed in
 * `CODE_REVIEW_STATUSES` for clients and legacy rows, but the status callback
 * maps a cloud-agent `interrupted` to `cancelled` before persisting, so no
 * review row this app writes holds it. Leaving it out keeps the auto
 * `completed_at` stamp tied to the statuses that actually end a review.
 */
export const TERMINAL_CODE_REVIEW_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type TerminalCodeReviewStatus = (typeof TERMINAL_CODE_REVIEW_STATUSES)[number];

export function isTerminalCodeReviewStatus(status: string): status is TerminalCodeReviewStatus {
  return (TERMINAL_CODE_REVIEW_STATUSES as readonly string[]).includes(status);
}

/**
 * Renders the in-flight status literals for raw SQL that cannot use
 * `inArray` — CTEs that filter an aliased column such as `attempts.status`.
 */
export function nonTerminalCodeReviewStatusListSql(): SQL {
  return sql.raw(NON_TERMINAL_CODE_REVIEW_STATUSES.map(status => `'${status}'`).join(', '));
}

export const STALE_QUEUED_CODE_REVIEW_MINUTES = 5;
export const STALE_RUNNING_CODE_REVIEW_MINUTES = 90;
export const CRON_PENDING_CODE_REVIEW_MIN_AGE_MINUTES = 60;
export const CRON_PENDING_CODE_REVIEW_MAX_AGE_MINUTES = 75;

export type PendingCodeReviewCreatedAtWindow = {
  createdAtAfter: SQL;
  createdAtBefore: SQL;
};

export function staleQueuedCodeReviewCutoffSql() {
  return sql`now() - interval '${sql.raw(String(STALE_QUEUED_CODE_REVIEW_MINUTES))} minutes'`;
}

export function staleRunningCodeReviewCutoffSql() {
  return sql`now() - interval '${sql.raw(String(STALE_RUNNING_CODE_REVIEW_MINUTES))} minutes'`;
}

export function cronPendingCodeReviewCreatedAtWindowSql(): PendingCodeReviewCreatedAtWindow {
  return {
    createdAtAfter: sql`now() - interval '${sql.raw(String(CRON_PENDING_CODE_REVIEW_MAX_AGE_MINUTES))} minutes'`,
    createdAtBefore: sql`now() - interval '${sql.raw(String(CRON_PENDING_CODE_REVIEW_MIN_AGE_MINUTES))} minutes'`,
  };
}

export function reconsiderableCodeReviewWorkCondition(
  staleQueuedCutoff = staleQueuedCodeReviewCutoffSql(),
  pendingCreatedAtWindow?: PendingCodeReviewCreatedAtWindow
) {
  const pendingClause = pendingCreatedAtWindow
    ? sql`(
        ${cloud_agent_code_reviews.status} = 'pending'
        AND ${cloud_agent_code_reviews.created_at} >= ${pendingCreatedAtWindow.createdAtAfter}
        AND ${cloud_agent_code_reviews.created_at} <= ${pendingCreatedAtWindow.createdAtBefore}
      )`
    : sql`${cloud_agent_code_reviews.status} = 'pending'`;

  return sql`(
    ${pendingClause}
    OR (
      ${cloud_agent_code_reviews.status} = 'queued'
      AND ${cloud_agent_code_reviews.updated_at} < ${staleQueuedCutoff}
    )
  )`;
}

export function activeCodeReviewWorkCondition(
  staleQueuedCutoff = staleQueuedCodeReviewCutoffSql(),
  staleRunningCutoff = staleRunningCodeReviewCutoffSql()
) {
  return sql`(
    (
      ${cloud_agent_code_reviews.status} = 'running'
      AND COALESCE(
        ${cloud_agent_code_reviews.started_at},
        ${cloud_agent_code_reviews.updated_at},
        ${cloud_agent_code_reviews.created_at}
      ) >= ${staleRunningCutoff}
    )
    OR (
      ${cloud_agent_code_reviews.status} = 'queued'
      AND ${cloud_agent_code_reviews.updated_at} >= ${staleQueuedCutoff}
    )
  )`;
}
