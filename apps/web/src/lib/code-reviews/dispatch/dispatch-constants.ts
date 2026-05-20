import { cloud_agent_code_reviews } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';

export const MAX_CONCURRENT_CODE_REVIEWS_PER_ORG = 20;
export const MAX_CONCURRENT_CODE_REVIEWS_PER_FUNDED_USER = 3;
export const MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER = 1;
export const FUNDED_CODE_REVIEW_BALANCE_THRESHOLD_MICRODOLLARS = 5_000_000;

export const STALE_QUEUED_CODE_REVIEW_MINUTES = 5;
export const STALE_RUNNING_CODE_REVIEW_MINUTES = 90;

export function staleQueuedCodeReviewCutoffSql() {
  return sql`now() - interval '${sql.raw(String(STALE_QUEUED_CODE_REVIEW_MINUTES))} minutes'`;
}

export function staleRunningCodeReviewCutoffSql() {
  return sql`now() - interval '${sql.raw(String(STALE_RUNNING_CODE_REVIEW_MINUTES))} minutes'`;
}

export function reconsiderableCodeReviewWorkCondition(
  staleQueuedCutoff = staleQueuedCodeReviewCutoffSql()
) {
  return sql`(
    ${cloud_agent_code_reviews.status} = 'pending'
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
