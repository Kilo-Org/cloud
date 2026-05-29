import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import * as z from 'zod';
import { sql, and, gte, lt, eq, isNotNull, desc, ilike, or, inArray, type SQL } from 'drizzle-orm';
import {
  reconsiderableCodeReviewWorkCondition,
  staleQueuedCodeReviewCutoffSql,
  staleRunningCodeReviewCutoffSql,
} from '@/lib/code-reviews/dispatch/dispatch-constants';

/**
 * SQL condition that identifies billing/credits errors (402 Payment Required).
 * Matches multiple error message patterns from different error paths:
 * - "Insufficient credits" from cloud-agent-next InsufficientCreditsError
 * - "paid model" / "add credits" / "Credits Required" from the 402 API response body
 */
const isBillingError = sql`(
  ${cloud_agent_code_reviews.terminal_reason} = 'billing'
  OR ${cloud_agent_code_reviews.error_message} ILIKE '%Insufficient credits%'
  OR ${cloud_agent_code_reviews.error_message} ILIKE '%paid model%'
  OR ${cloud_agent_code_reviews.error_message} ILIKE '%add credits%'
  OR ${cloud_agent_code_reviews.error_message} ILIKE '%Credits Required%'
)`;

const isBillingAttemptError = sql`(
  ${cloud_agent_code_review_attempts.terminal_reason} = 'billing'
  OR ${cloud_agent_code_review_attempts.error_message} ILIKE '%Insufficient credits%'
  OR ${cloud_agent_code_review_attempts.error_message} ILIKE '%paid model%'
  OR ${cloud_agent_code_review_attempts.error_message} ILIKE '%add credits%'
  OR ${cloud_agent_code_review_attempts.error_message} ILIKE '%Credits Required%'
)`;

const isModelNotFound = sql`(
  ${cloud_agent_code_reviews.terminal_reason} = 'model_not_found'
  OR ${cloud_agent_code_reviews.error_message} ILIKE '%model not found%'
)`;

const isModelNotFoundAttempt = sql`(
  ${cloud_agent_code_review_attempts.terminal_reason} = 'model_not_found'
  OR ${cloud_agent_code_review_attempts.error_message} ILIKE '%model not found%'
)`;

/**
 * SQL condition to exclude billing errors from failure metrics.
 * Uses COALESCE to handle NULL error_message (NULL NOT LIKE returns NULL, not TRUE).
 */
const excludeBillingErrors = sql`COALESCE(${cloud_agent_code_reviews.terminal_reason}, '') <> 'billing'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%Insufficient credits%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%paid model%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%add credits%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%Credits Required%'`;

const excludeBillingAttemptErrors = sql`COALESCE(${cloud_agent_code_review_attempts.terminal_reason}, '') <> 'billing'
  AND COALESCE(${cloud_agent_code_review_attempts.error_message}, '') NOT ILIKE '%Insufficient credits%'
  AND COALESCE(${cloud_agent_code_review_attempts.error_message}, '') NOT ILIKE '%paid model%'
  AND COALESCE(${cloud_agent_code_review_attempts.error_message}, '') NOT ILIKE '%add credits%'
  AND COALESCE(${cloud_agent_code_review_attempts.error_message}, '') NOT ILIKE '%Credits Required%'`;

const excludeModelNotFound = sql`COALESCE(${cloud_agent_code_reviews.terminal_reason}, '') <> 'model_not_found'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%model not found%'`;

const excludeModelNotFoundAttempt = sql`COALESCE(${cloud_agent_code_review_attempts.terminal_reason}, '') <> 'model_not_found'
  AND COALESCE(${cloud_agent_code_review_attempts.error_message}, '') NOT ILIKE '%model not found%'`;

/**
 * Categorize error messages into high-level buckets via SQL CASE WHEN.
 * Pattern matching is ordered from most-specific to least-specific.
 */
const errorCategoryExpr = sql<string>`CASE
  WHEN ${cloud_agent_code_reviews.terminal_reason} IN ('github_installation_required', 'github_ip_allow_list', 'byok_invalid_key') THEN 'Action Required'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%rate limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Rate limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%429%' THEN 'Rate Limited'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%timeout%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Timeout%' OR ${cloud_agent_code_reviews.error_message} LIKE '%ETIMEDOUT%' OR ${cloud_agent_code_reviews.error_message} LIKE '%timed out%' THEN 'Timeout'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%context window%' OR ${cloud_agent_code_reviews.error_message} LIKE '%token limit%' OR ${cloud_agent_code_reviews.error_message} LIKE '%too large%' OR ${cloud_agent_code_reviews.error_message} LIKE '%maximum context length%' THEN 'Context Window Exceeded'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%authentication%' OR ${cloud_agent_code_reviews.error_message} LIKE '%401%' OR ${cloud_agent_code_reviews.error_message} LIKE '%403%' OR ${cloud_agent_code_reviews.error_message} LIKE '%permission%' THEN 'Auth / Permission Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%not found%' OR ${cloud_agent_code_reviews.error_message} LIKE '%404%' THEN 'Not Found'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%500%' OR ${cloud_agent_code_reviews.error_message} LIKE '%502%' OR ${cloud_agent_code_reviews.error_message} LIKE '%503%' OR ${cloud_agent_code_reviews.error_message} LIKE '%internal server%' OR ${cloud_agent_code_reviews.error_message} LIKE '%Internal Server%' THEN 'Upstream Server Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%ECONNREFUSED%' OR ${cloud_agent_code_reviews.error_message} LIKE '%ECONNRESET%' OR ${cloud_agent_code_reviews.error_message} LIKE '%socket hang up%' OR ${cloud_agent_code_reviews.error_message} LIKE '%network%' THEN 'Network Error'
  WHEN ${cloud_agent_code_reviews.error_message} LIKE '%parse%' OR ${cloud_agent_code_reviews.error_message} LIKE '%JSON%' OR ${cloud_agent_code_reviews.error_message} LIKE '%unexpected token%' THEN 'Parse Error'
  WHEN ${cloud_agent_code_reviews.error_message} IS NULL THEN 'Unknown Error'
  ELSE 'Other'
END`;

const attemptErrorCategoryExpr = sql<string>`CASE
  WHEN ${cloud_agent_code_review_attempts.terminal_reason} IN ('github_installation_required', 'github_ip_allow_list', 'byok_invalid_key') THEN 'Action Required'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%rate limit%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%Rate limit%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%429%' THEN 'Rate Limited'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%timeout%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%Timeout%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%ETIMEDOUT%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%timed out%' THEN 'Timeout'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%context window%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%token limit%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%too large%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%maximum context length%' THEN 'Context Window Exceeded'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%authentication%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%401%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%403%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%permission%' THEN 'Auth / Permission Error'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%not found%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%404%' THEN 'Not Found'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%500%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%502%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%503%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%internal server%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%Internal Server%' THEN 'Upstream Server Error'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%ECONNREFUSED%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%ECONNRESET%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%socket hang up%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%network%' THEN 'Network Error'
  WHEN ${cloud_agent_code_review_attempts.error_message} LIKE '%parse%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%JSON%' OR ${cloud_agent_code_review_attempts.error_message} LIKE '%unexpected token%' THEN 'Parse Error'
  WHEN ${cloud_agent_code_review_attempts.error_message} IS NULL THEN 'Unknown Error'
  ELSE 'Other'
END`;

const FilterSchemaShape = {
  startDate: z.string().datetime(), // ISO datetime string
  endDate: z.string().datetime(), // ISO datetime string
  userId: z.string().min(1).optional(), // Filter by specific user
  organizationId: z.string().uuid().optional(), // Filter by specific organization
  ownershipType: z.enum(['all', 'personal', 'organization']).optional().default('all'),
  retryAccountingMode: z
    .enum(['final_outcome', 'all_attempts'])
    .optional()
    .default('final_outcome'),
};

type DateIntervalInput = {
  startDate: string;
  endDate: string;
};

const MAX_TELEMETRY_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;

function hasAscendingDateInterval(input: DateIntervalInput): boolean {
  return new Date(input.startDate).getTime() < new Date(input.endDate).getTime();
}

function hasBoundedDateInterval(input: DateIntervalInput): boolean {
  return (
    new Date(input.endDate).getTime() - new Date(input.startDate).getTime() <=
    MAX_TELEMETRY_INTERVAL_MS
  );
}

const intervalOrderValidation = {
  message: 'Start date must be before end date',
  path: ['endDate'],
};
const intervalLengthValidation = {
  message: 'Date interval cannot exceed 90 days',
  path: ['endDate'],
};

const FilterSchema = z
  .object(FilterSchemaShape)
  .refine(hasAscendingDateInterval, intervalOrderValidation)
  .refine(hasBoundedDateInterval, intervalLengthValidation);
const ErrorSessionsFilterSchema = z
  .object({ ...FilterSchemaShape, errorMessage: z.string().min(1) })
  .refine(hasAscendingDateInterval, intervalOrderValidation)
  .refine(hasBoundedDateInterval, intervalLengthValidation);

type FilterInput = z.infer<typeof FilterSchema>;

/**
 * Helper to build ownership filter conditions.
 *
 * Returns undefined when filtering is "all ownership types" which is intentional -
 * the date range conditions (startDate, endDate) are always required and applied,
 * ensuring queries are bounded even without ownership filters.
 */
function buildOwnershipFilter(
  userId?: string,
  organizationId?: string,
  ownershipType?: 'all' | 'personal' | 'organization'
): SQL | undefined {
  const conditions: SQL[] = [];

  if (userId) {
    conditions.push(eq(cloud_agent_code_reviews.owned_by_user_id, userId));
  }

  if (organizationId) {
    conditions.push(eq(cloud_agent_code_reviews.owned_by_organization_id, organizationId));
  }

  if (!userId && !organizationId && ownershipType && ownershipType !== 'all') {
    if (ownershipType === 'personal') {
      conditions.push(isNotNull(cloud_agent_code_reviews.owned_by_user_id));
    } else if (ownershipType === 'organization') {
      conditions.push(isNotNull(cloud_agent_code_reviews.owned_by_organization_id));
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

const ownershipTypeExpr = sql<string>`CASE WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'organization' ELSE 'personal' END`;
const waitSecondsExpr = sql<number>`EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.started_at} - ${cloud_agent_code_reviews.created_at}))`;
const validStartedWaitCondition = sql`${cloud_agent_code_reviews.started_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} >= ${cloud_agent_code_reviews.created_at}`;
const attemptWaitSecondsExpr = sql<number>`EXTRACT(EPOCH FROM (${cloud_agent_code_review_attempts.started_at} - ${cloud_agent_code_review_attempts.created_at}))`;
const validAttemptStartedWaitCondition = sql`${cloud_agent_code_review_attempts.started_at} IS NOT NULL AND ${cloud_agent_code_review_attempts.started_at} >= ${cloud_agent_code_review_attempts.created_at}`;

function accountingCreatedAt(input: FilterInput) {
  return input.retryAccountingMode === 'all_attempts'
    ? cloud_agent_code_review_attempts.created_at
    : cloud_agent_code_reviews.created_at;
}

function accountingDayExpr(input: FilterInput): SQL {
  return sql`DATE_TRUNC('day', ${accountingCreatedAt(input)})`;
}

function buildBaseConditions(input: FilterInput): SQL[] {
  const createdAt = accountingCreatedAt(input);
  const conditions = [gte(createdAt, input.startDate), lt(createdAt, input.endDate)];
  const ownershipFilter = buildOwnershipFilter(
    input.userId,
    input.organizationId,
    input.ownershipType
  );
  if (ownershipFilter) {
    conditions.push(ownershipFilter);
  }

  return conditions;
}

export const adminCodeReviewsRouter = createTRPCRouter({
  getQueueHealthStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const ownershipFilter = buildOwnershipFilter(
      input.userId,
      input.organizationId,
      input.ownershipType
    );
    const staleQueuedCutoff = staleQueuedCodeReviewCutoffSql();
    const staleRunningCutoff = staleRunningCodeReviewCutoffSql();
    const waitingOwnerCondition = reconsiderableCodeReviewWorkCondition(staleQueuedCutoff);
    const liveQueueCondition = sql`(
      ${waitingOwnerCondition}
      OR (
        ${cloud_agent_code_reviews.status} = 'running'
        AND COALESCE(
          ${cloud_agent_code_reviews.started_at},
          ${cloud_agent_code_reviews.updated_at},
          ${cloud_agent_code_reviews.created_at}
        ) < ${staleRunningCutoff}
      )
    )`;

    const query = db
      .select({
        pending_review_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'pending')`,
        pending_over_five_minutes_count: sql<number>`COUNT(*) FILTER (
          WHERE ${cloud_agent_code_reviews.status} = 'pending'
            AND ${cloud_agent_code_reviews.created_at} < ${staleQueuedCutoff}
        )`,
        oldest_pending_age_seconds: sql<number>`COALESCE(
          MAX(EXTRACT(EPOCH FROM (now() - ${cloud_agent_code_reviews.created_at}))) FILTER (
            WHERE ${cloud_agent_code_reviews.status} = 'pending'
          ),
          0
        )`,
        stale_queued_claim_count: sql<number>`COUNT(*) FILTER (
          WHERE ${cloud_agent_code_reviews.status} = 'queued'
            AND ${cloud_agent_code_reviews.updated_at} < ${staleQueuedCutoff}
        )`,
        running_over_ninety_minutes_count: sql<number>`COUNT(*) FILTER (
          WHERE ${cloud_agent_code_reviews.status} = 'running'
            AND COALESCE(
              ${cloud_agent_code_reviews.started_at},
              ${cloud_agent_code_reviews.updated_at},
              ${cloud_agent_code_reviews.created_at}
            ) < ${staleRunningCutoff}
        )`,
        owners_with_waiting_reviews_count: sql<number>`COUNT(DISTINCT CASE
          WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL
            THEN CONCAT('org:', ${cloud_agent_code_reviews.owned_by_organization_id}::text)
          ELSE CONCAT('user:', ${cloud_agent_code_reviews.owned_by_user_id})
        END) FILTER (WHERE ${waitingOwnerCondition})`,
      })
      .from(cloud_agent_code_reviews);

    const queueHealthCondition = ownershipFilter
      ? and(liveQueueCondition, ownershipFilter)
      : liveQueueCondition;
    const result = await query.where(queueHealthCondition);
    const stats = result[0];

    return {
      pendingReviewCount: Number(stats?.pending_review_count) || 0,
      pendingOverFiveMinutesCount: Number(stats?.pending_over_five_minutes_count) || 0,
      oldestPendingAgeSeconds: Number(stats?.oldest_pending_age_seconds) || 0,
      staleQueuedClaimCount: Number(stats?.stale_queued_claim_count) || 0,
      runningOverNinetyMinutesCount: Number(stats?.running_over_ninety_minutes_count) || 0,
      ownersWithWaitingReviewsCount: Number(stats?.owners_with_waiting_reviews_count) || 0,
    };
  }),

  // Get overview KPIs
  getOverviewStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const conditions = buildBaseConditions(input);
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const billingError =
      input.retryAccountingMode === 'all_attempts' ? isBillingAttemptError : isBillingError;
    const excludeBilling =
      input.retryAccountingMode === 'all_attempts'
        ? excludeBillingAttemptErrors
        : excludeBillingErrors;
    const excludeModelUnavailable =
      input.retryAccountingMode === 'all_attempts'
        ? excludeModelNotFoundAttempt
        : excludeModelNotFound;
    const modelUnavailable =
      input.retryAccountingMode === 'all_attempts' ? isModelNotFoundAttempt : isModelNotFound;
    const durationStartedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.started_at
        : cloud_agent_code_reviews.started_at;
    const durationCompletedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.completed_at
        : cloud_agent_code_reviews.completed_at;
    const waitCondition =
      input.retryAccountingMode === 'all_attempts'
        ? validAttemptStartedWaitCondition
        : validStartedWaitCondition;
    const waitSeconds =
      input.retryAccountingMode === 'all_attempts' ? attemptWaitSecondsExpr : waitSecondsExpr;
    const waitCreatedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.created_at
        : cloud_agent_code_reviews.created_at;
    const waitStartedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.started_at
        : cloud_agent_code_reviews.started_at;

    const query = db
      .select({
        total_reviews: sql<number>`COUNT(*)`,
        completed_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'completed')`,
        // Exclude billing errors from system failure count — they get their own KPI
        failed_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'failed' AND ${excludeBilling} AND ${excludeModelUnavailable})`,
        cancelled_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'cancelled' OR (${statusTable.status} = 'failed' AND ${modelUnavailable}))`,
        interrupted_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'interrupted')`,
        in_progress_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} IN ('pending', 'queued', 'running'))`,
        avg_duration_seconds: sql<number>`AVG(EXTRACT(EPOCH FROM (${durationCompletedAt}::timestamp - ${durationStartedAt}::timestamp))) FILTER (WHERE ${durationCompletedAt} IS NOT NULL AND ${durationStartedAt} IS NOT NULL)`,
        wait_started_count: sql<number>`COUNT(*) FILTER (WHERE ${waitCondition})`,
        avg_wait_seconds: sql<number>`AVG(${waitSeconds}) FILTER (WHERE ${waitCondition})`,
        p95_wait_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSeconds}) FILTER (WHERE ${waitCondition})`,
        p99_wait_seconds: sql<number>`percentile_cont(0.99) WITHIN GROUP (ORDER BY ${waitSeconds}) FILTER (WHERE ${waitCondition})`,
        max_wait_seconds: sql<number>`MAX(${waitSeconds}) FILTER (WHERE ${waitCondition})`,
        within_5m_wait_count: sql<number>`COUNT(*) FILTER (WHERE ${waitCondition} AND ${waitStartedAt} <= ${waitCreatedAt} + INTERVAL '5 minutes')`,
        // Billing errors (402): not system failures, not cancellations — separate bucket
        billing_error_count: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'failed' AND ${billingError})`,
      })
      .from(cloud_agent_code_reviews);

    const result =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
        : await query.where(and(...conditions));

    const stats = result[0];
    const total = Number(stats.total_reviews) || 0;
    const completedCount = Number(stats.completed_count) || 0;
    const failedCount = Number(stats.failed_count) || 0;
    const cancelledCount = Number(stats.cancelled_count) || 0;
    const interruptedCount = Number(stats.interrupted_count) || 0;
    const inProgressCount = Number(stats.in_progress_count) || 0;
    const billingErrorCount = Number(stats.billing_error_count) || 0;
    const waitStartedCount = Number(stats.wait_started_count) || 0;
    const withinFiveMinuteWaitCount = Number(stats.within_5m_wait_count) || 0;

    // Calculate rates over terminal states only (completed, failed, interrupted, cancelled, billing errors)
    // In-progress states (pending, queued, running) are excluded as they haven't finished yet
    // billingErrorCount is excluded from failedCount but included in terminal count
    const terminalCount =
      completedCount + failedCount + interruptedCount + cancelledCount + billingErrorCount;

    return {
      totalReviews: total,
      retryAccountingMode: input.retryAccountingMode,
      completedCount,
      failedCount,
      cancelledCount,
      interruptedCount,
      inProgressCount,
      billingErrorCount,
      billingRate: terminalCount > 0 ? (billingErrorCount / terminalCount) * 100 : 0,
      // Success rate = completed / terminal states
      successRate: terminalCount > 0 ? (completedCount / terminalCount) * 100 : 0,
      // Failure rate = (failed + interrupted) / terminal states
      failureRate: terminalCount > 0 ? ((failedCount + interruptedCount) / terminalCount) * 100 : 0,
      // Cancelled rate = cancelled / terminal states (the remainder to reach 100%)
      cancelledRate: terminalCount > 0 ? (cancelledCount / terminalCount) * 100 : 0,
      avgDurationSeconds: Number(stats.avg_duration_seconds) || 0,
      waitStartedCount,
      avgWaitSeconds: Number(stats.avg_wait_seconds) || 0,
      p95WaitSeconds: Number(stats.p95_wait_seconds) || 0,
      p99WaitSeconds: Number(stats.p99_wait_seconds) || 0,
      maxWaitSeconds: Number(stats.max_wait_seconds) || 0,
      waitWithinFiveMinuteRate:
        waitStartedCount > 0 ? (withinFiveMinuteWaitCount / waitStartedCount) * 100 : 0,
    };
  }),

  // Get daily time series data
  getDailyStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const conditions = buildBaseConditions(input);
    const dayExpr = accountingDayExpr(input);
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const billingError =
      input.retryAccountingMode === 'all_attempts' ? isBillingAttemptError : isBillingError;
    const excludeBilling =
      input.retryAccountingMode === 'all_attempts'
        ? excludeBillingAttemptErrors
        : excludeBillingErrors;
    const excludeModelUnavailable =
      input.retryAccountingMode === 'all_attempts'
        ? excludeModelNotFoundAttempt
        : excludeModelNotFound;
    const modelUnavailable =
      input.retryAccountingMode === 'all_attempts' ? isModelNotFoundAttempt : isModelNotFound;

    const query = db
      .select({
        day: sql<string>`${dayExpr}::date::text`,
        total: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'completed')`,
        // Exclude billing errors from system failure count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'failed' AND ${excludeBilling} AND ${excludeModelUnavailable})`,
        cancelled: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'cancelled' OR (${statusTable.status} = 'failed' AND ${modelUnavailable}))`,
        interrupted: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'interrupted')`,
        in_progress: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} IN ('pending', 'queued', 'running'))`,
        billing_errors: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'failed' AND ${billingError})`,
      })
      .from(cloud_agent_code_reviews);

    const result =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(dayExpr)
            .orderBy(dayExpr)
        : await query
            .where(and(...conditions))
            .groupBy(dayExpr)
            .orderBy(dayExpr);

    return result.map(row => ({
      day: row.day,
      total: Number(row.total) || 0,
      completed: Number(row.completed) || 0,
      failed: Number(row.failed) || 0,
      cancelled: Number(row.cancelled) || 0,
      interrupted: Number(row.interrupted) || 0,
      inProgress: Number(row.in_progress) || 0,
      billingErrors: Number(row.billing_errors) || 0,
    }));
  }),

  // Get cancellation reasons analysis
  getCancellationAnalysis: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const createdAt = accountingCreatedAt(input);
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;

    const modelUnavailable =
      input.retryAccountingMode === 'all_attempts' ? isModelNotFoundAttempt : isModelNotFound;

    const conditions = [
      sql`(${statusTable.status} = 'cancelled' OR (${statusTable.status} = 'failed' AND ${modelUnavailable}))`,
      ...buildBaseConditions(input),
    ] as SQL[];

    const cancellationReasonExpr = sql<string>`CASE
      WHEN ${statusTable.terminal_reason} = 'model_not_found' OR ${statusTable.error_message} ILIKE '%model not found%' THEN 'Model no longer available'
      WHEN ${statusTable.terminal_reason} = 'superseded' OR ${statusTable.error_message} ILIKE '%superseded%' THEN 'Superseded by new commit'
      WHEN ${statusTable.error_message} ILIKE '%stream timeout%' THEN 'Stream timeout'
      WHEN ${statusTable.terminal_reason} = 'user_cancelled' OR ${statusTable.error_message} ILIKE '%cancelled%' OR ${statusTable.error_message} ILIKE '%canceled%' THEN 'Explicitly cancelled'
      WHEN ${statusTable.error_message} ILIKE '%killed%' OR ${statusTable.error_message} ILIKE '%sigkill%' OR ${statusTable.error_message} ILIKE '%sigterm%' THEN 'Process killed'
      WHEN ${statusTable.terminal_reason} = 'interrupted' OR ${statusTable.error_message} ILIKE '%interrupted%' THEN 'User interrupted'
      WHEN ${statusTable.error_message} IS NULL THEN 'No reason provided'
      ELSE 'Other'
    END`;

    const query = db
      .select({
        reason: cancellationReasonExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${createdAt})::text`,
        last_occurrence: sql<string>`MAX(${createdAt})::text`,
      })
      .from(cloud_agent_code_reviews);

    const reasons =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(cancellationReasonExpr)
            .orderBy(desc(sql`COUNT(*)`))
        : await query
            .where(and(...conditions))
            .groupBy(cancellationReasonExpr)
            .orderBy(desc(sql`COUNT(*)`));

    return reasons.map(row => ({
      reason: row.reason,
      count: Number(row.count) || 0,
      firstOccurrence: row.first_occurrence,
      lastOccurrence: row.last_occurrence,
    }));
  }),

  // Get error analysis (excludes billing errors — those have their own KPI bucket)
  getErrorAnalysis: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const createdAt = accountingCreatedAt(input);
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const errorCategory =
      input.retryAccountingMode === 'all_attempts' ? attemptErrorCategoryExpr : errorCategoryExpr;
    const errorMessageColumn =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.error_message
        : cloud_agent_code_reviews.error_message;
    const excludeBilling =
      input.retryAccountingMode === 'all_attempts'
        ? excludeBillingAttemptErrors
        : excludeBillingErrors;
    const excludeModelUnavailable =
      input.retryAccountingMode === 'all_attempts'
        ? excludeModelNotFoundAttempt
        : excludeModelNotFound;

    const conditions = [
      eq(statusTable.status, 'failed'),
      excludeBilling,
      excludeModelUnavailable,
      ...buildBaseConditions(input),
    ] as SQL[];

    // Categorized error summary
    const categorizedQuery = db
      .select({
        category: errorCategory,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${createdAt})::text`,
        last_occurrence: sql<string>`MAX(${createdAt})::text`,
      })
      .from(cloud_agent_code_reviews);

    const categorized =
      input.retryAccountingMode === 'all_attempts'
        ? await categorizedQuery
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(errorCategory)
            .orderBy(desc(sql`COUNT(*)`))
        : await categorizedQuery
            .where(and(...conditions))
            .groupBy(errorCategory)
            .orderBy(desc(sql`COUNT(*)`));

    // Raw error messages (top 50, for drill-down table)
    const rawQuery = db
      .select({
        error_type: sql<string>`COALESCE(SUBSTRING(${errorMessageColumn} FROM 1 FOR 200), 'Unknown Error')`,
        category: errorCategory,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${createdAt})::text`,
        last_occurrence: sql<string>`MAX(${createdAt})::text`,
      })
      .from(cloud_agent_code_reviews);

    const raw =
      input.retryAccountingMode === 'all_attempts'
        ? await rawQuery
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(sql`SUBSTRING(${errorMessageColumn} FROM 1 FOR 200)`, errorCategory)
            .orderBy(desc(sql`COUNT(*)`))
            .limit(50)
        : await rawQuery
            .where(and(...conditions))
            .groupBy(sql`SUBSTRING(${errorMessageColumn} FROM 1 FOR 200)`, errorCategory)
            .orderBy(desc(sql`COUNT(*)`))
            .limit(50);

    return {
      categories: categorized.map(row => ({
        category: row.category,
        count: Number(row.count) || 0,
        firstOccurrence: row.first_occurrence,
        lastOccurrence: row.last_occurrence,
      })),
      details: raw.map(row => ({
        errorType: row.error_type,
        category: row.category,
        count: Number(row.count) || 0,
        firstOccurrence: row.first_occurrence,
        lastOccurrence: row.last_occurrence,
      })),
    };
  }),

  // Get the 20 most recent sessions for a specific error message pattern (drill-down from error table)
  getErrorSessions: adminProcedure.input(ErrorSessionsFilterSchema).query(async ({ input }) => {
    const { errorMessage } = input;
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const errorMessageColumn =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.error_message
        : cloud_agent_code_reviews.error_message;
    const excludeBilling =
      input.retryAccountingMode === 'all_attempts'
        ? excludeBillingAttemptErrors
        : excludeBillingErrors;
    const excludeModelUnavailable =
      input.retryAccountingMode === 'all_attempts'
        ? excludeModelNotFoundAttempt
        : excludeModelNotFound;

    const conditions = [
      eq(statusTable.status, 'failed'),
      excludeBilling,
      excludeModelUnavailable,
      eq(
        sql`COALESCE(SUBSTRING(${errorMessageColumn} FROM 1 FOR 200), 'Unknown Error')`,
        errorMessage
      ),
      ...buildBaseConditions(input),
    ] as SQL[];

    const query = db
      .select({
        review_id: cloud_agent_code_reviews.id,
        session_id:
          input.retryAccountingMode === 'all_attempts'
            ? cloud_agent_code_review_attempts.session_id
            : cloud_agent_code_reviews.session_id,
        cli_session_id:
          input.retryAccountingMode === 'all_attempts'
            ? cloud_agent_code_review_attempts.cli_session_id
            : cloud_agent_code_reviews.cli_session_id,
        attempt_id:
          input.retryAccountingMode === 'all_attempts'
            ? cloud_agent_code_review_attempts.id
            : sql<string | null>`NULL`,
        attempt_number:
          input.retryAccountingMode === 'all_attempts'
            ? cloud_agent_code_review_attempts.attempt_number
            : sql<number | null>`NULL`,
        user_id: cloud_agent_code_reviews.owned_by_user_id,
        org_id: cloud_agent_code_reviews.owned_by_organization_id,
        error_message: errorMessageColumn,
        created_at:
          input.retryAccountingMode === 'all_attempts'
            ? cloud_agent_code_review_attempts.created_at
            : cloud_agent_code_reviews.created_at,
        repo_full_name: cloud_agent_code_reviews.repo_full_name,
        pr_number: cloud_agent_code_reviews.pr_number,
      })
      .from(cloud_agent_code_reviews);

    const rows =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .orderBy(desc(cloud_agent_code_review_attempts.created_at))
            .limit(20)
        : await query
            .where(and(...conditions))
            .orderBy(desc(cloud_agent_code_reviews.created_at))
            .limit(20);

    return rows.map(row => ({
      reviewId: row.review_id,
      sessionId: row.session_id,
      cliSessionId: row.cli_session_id,
      attemptId: input.retryAccountingMode === 'all_attempts' ? row.attempt_id : null,
      attemptNumber: input.retryAccountingMode === 'all_attempts' ? row.attempt_number : null,
      userId: row.user_id,
      orgId: row.org_id,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      repoFullName: row.repo_full_name,
      prNumber: row.pr_number,
    }));
  }),

  // Get user segmentation (note: this doesn't use filters since it shows top users/orgs for selection)
  getUserSegmentation: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { userId, organizationId } = input;
    const baseConditions = buildBaseConditions(input);
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const excludeBilling =
      input.retryAccountingMode === 'all_attempts'
        ? excludeBillingAttemptErrors
        : excludeBillingErrors;
    const excludeModelUnavailable =
      input.retryAccountingMode === 'all_attempts'
        ? excludeModelNotFoundAttempt
        : excludeModelNotFound;
    const waitCondition =
      input.retryAccountingMode === 'all_attempts'
        ? validAttemptStartedWaitCondition
        : validStartedWaitCondition;
    const waitSeconds =
      input.retryAccountingMode === 'all_attempts' ? attemptWaitSecondsExpr : waitSecondsExpr;

    // Personal vs Org breakdown
    const ownershipBreakdownQuery = db
      .select({
        ownership_type: ownershipTypeExpr,
        count: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'completed')`,
        // Exclude billing errors from failed count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${statusTable.status} = 'failed' AND ${excludeBilling} AND ${excludeModelUnavailable})`,
        wait_started_count: sql<number>`COUNT(*) FILTER (WHERE ${waitCondition})`,
        avg_wait_seconds: sql<number>`AVG(${waitSeconds}) FILTER (WHERE ${waitCondition})`,
        p95_wait_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSeconds}) FILTER (WHERE ${waitCondition})`,
      })
      .from(cloud_agent_code_reviews);

    const ownershipBreakdown =
      input.retryAccountingMode === 'all_attempts'
        ? await ownershipBreakdownQuery
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...baseConditions))
            .groupBy(ownershipTypeExpr)
        : await ownershipBreakdownQuery.where(and(...baseConditions)).groupBy(ownershipTypeExpr);

    // Top users (only show if not filtering by specific user)
    const topUsers = userId
      ? []
      : input.retryAccountingMode === 'all_attempts'
        ? await db
            .select({
              user_id: cloud_agent_code_reviews.owned_by_user_id,
              email: kilocode_users.google_user_email,
              name: kilocode_users.google_user_name,
              review_count: sql<number>`COUNT(*)`,
              completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_review_attempts.status} = 'completed')`,
            })
            .from(cloud_agent_code_reviews)
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .leftJoin(
              kilocode_users,
              eq(cloud_agent_code_reviews.owned_by_user_id, kilocode_users.id)
            )
            .where(and(isNotNull(cloud_agent_code_reviews.owned_by_user_id), ...baseConditions))
            .groupBy(
              cloud_agent_code_reviews.owned_by_user_id,
              kilocode_users.google_user_email,
              kilocode_users.google_user_name
            )
            .orderBy(desc(sql`COUNT(*)`))
            .limit(10)
        : await db
            .select({
              user_id: cloud_agent_code_reviews.owned_by_user_id,
              email: kilocode_users.google_user_email,
              name: kilocode_users.google_user_name,
              review_count: sql<number>`COUNT(*)`,
              completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
            })
            .from(cloud_agent_code_reviews)
            .leftJoin(
              kilocode_users,
              eq(cloud_agent_code_reviews.owned_by_user_id, kilocode_users.id)
            )
            .where(and(isNotNull(cloud_agent_code_reviews.owned_by_user_id), ...baseConditions))
            .groupBy(
              cloud_agent_code_reviews.owned_by_user_id,
              kilocode_users.google_user_email,
              kilocode_users.google_user_name
            )
            .orderBy(desc(sql`COUNT(*)`))
            .limit(10);

    // Top organizations (only show if not filtering by specific org)
    const topOrgs = organizationId
      ? []
      : input.retryAccountingMode === 'all_attempts'
        ? await db
            .select({
              org_id: cloud_agent_code_reviews.owned_by_organization_id,
              org_name: organizations.name,
              org_plan: organizations.plan,
              review_count: sql<number>`COUNT(*)`,
              completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_review_attempts.status} = 'completed')`,
            })
            .from(cloud_agent_code_reviews)
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .leftJoin(
              organizations,
              eq(cloud_agent_code_reviews.owned_by_organization_id, organizations.id)
            )
            .where(
              and(isNotNull(cloud_agent_code_reviews.owned_by_organization_id), ...baseConditions)
            )
            .groupBy(
              cloud_agent_code_reviews.owned_by_organization_id,
              organizations.name,
              organizations.plan
            )
            .orderBy(desc(sql`COUNT(*)`))
            .limit(10)
        : await db
            .select({
              org_id: cloud_agent_code_reviews.owned_by_organization_id,
              org_name: organizations.name,
              org_plan: organizations.plan,
              review_count: sql<number>`COUNT(*)`,
              completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
            })
            .from(cloud_agent_code_reviews)
            .leftJoin(
              organizations,
              eq(cloud_agent_code_reviews.owned_by_organization_id, organizations.id)
            )
            .where(
              and(isNotNull(cloud_agent_code_reviews.owned_by_organization_id), ...baseConditions)
            )
            .groupBy(
              cloud_agent_code_reviews.owned_by_organization_id,
              organizations.name,
              organizations.plan
            )
            .orderBy(desc(sql`COUNT(*)`))
            .limit(10);

    return {
      ownershipBreakdown: ownershipBreakdown.map(row => ({
        type: row.ownership_type,
        count: Number(row.count) || 0,
        completed: Number(row.completed) || 0,
        failed: Number(row.failed) || 0,
        waitStartedCount: Number(row.wait_started_count) || 0,
        avgWaitSeconds: Number(row.avg_wait_seconds) || 0,
        p95WaitSeconds: Number(row.p95_wait_seconds) || 0,
      })),
      topUsers: topUsers.map(row => ({
        userId: row.user_id,
        email: row.email,
        name: row.name,
        reviewCount: Number(row.review_count) || 0,
        completedCount: Number(row.completed_count) || 0,
      })),
      topOrgs: topOrgs.map(row => ({
        orgId: row.org_id,
        name: row.org_name,
        plan: row.org_plan,
        reviewCount: Number(row.review_count) || 0,
        completedCount: Number(row.completed_count) || 0,
      })),
    };
  }),

  // Get daily queue wait percentiles (wait time = started_at - created_at)
  getWaitTimeStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const waitCondition =
      input.retryAccountingMode === 'all_attempts'
        ? validAttemptStartedWaitCondition
        : validStartedWaitCondition;
    const waitSeconds =
      input.retryAccountingMode === 'all_attempts' ? attemptWaitSecondsExpr : waitSecondsExpr;
    const conditions = [...buildBaseConditions(input), waitCondition] as SQL[];

    const dayExpr = accountingDayExpr(input);

    const query = db
      .select({
        day: sql<string>`${dayExpr}::date::text`,
        ownership_type: ownershipTypeExpr,
        avg_seconds: sql<number>`AVG(${waitSeconds})`,
        p50_seconds: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${waitSeconds})`,
        p95_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSeconds})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(cloud_agent_code_reviews);

    const result =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(dayExpr, ownershipTypeExpr)
            .orderBy(dayExpr, ownershipTypeExpr)
        : await query
            .where(and(...conditions))
            .groupBy(dayExpr, ownershipTypeExpr)
            .orderBy(dayExpr, ownershipTypeExpr);

    return result.map(row => ({
      day: row.day,
      ownershipType: row.ownership_type,
      avgSeconds: Number(row.avg_seconds) || 0,
      p50Seconds: Number(row.p50_seconds) || 0,
      p95Seconds: Number(row.p95_seconds) || 0,
      count: Number(row.count) || 0,
    }));
  }),

  // Get daily performance percentiles (execution time = completed_at - started_at)
  getPerformanceStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const statusTable =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts
        : cloud_agent_code_reviews;
    const startedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.started_at
        : cloud_agent_code_reviews.started_at;
    const completedAt =
      input.retryAccountingMode === 'all_attempts'
        ? cloud_agent_code_review_attempts.completed_at
        : cloud_agent_code_reviews.completed_at;

    const conditions = [
      eq(statusTable.status, 'completed'),
      ...buildBaseConditions(input),
      isNotNull(completedAt),
      isNotNull(startedAt),
    ] as SQL[];

    const durationExpr = sql`EXTRACT(EPOCH FROM (${completedAt}::timestamp - ${startedAt}::timestamp))`;
    const dayExpr = accountingDayExpr(input);

    const query = db
      .select({
        day: sql<string>`${dayExpr}::date::text`,
        avg_seconds: sql<number>`AVG(${durationExpr})`,
        p50_seconds: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${durationExpr})`,
        p90_seconds: sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${durationExpr})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(cloud_agent_code_reviews);

    const result =
      input.retryAccountingMode === 'all_attempts'
        ? await query
            .innerJoin(
              cloud_agent_code_review_attempts,
              eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
            )
            .where(and(...conditions))
            .groupBy(dayExpr)
            .orderBy(dayExpr)
        : await query
            .where(and(...conditions))
            .groupBy(dayExpr)
            .orderBy(dayExpr);

    return result.map(row => ({
      day: row.day,
      avgSeconds: Number(row.avg_seconds) || 0,
      p50Seconds: Number(row.p50_seconds) || 0,
      p90Seconds: Number(row.p90_seconds) || 0,
      count: Number(row.count) || 0,
    }));
  }),

  // Get CSV export data
  getExportData: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const conditions = buildBaseConditions(input);

    if (input.retryAccountingMode === 'all_attempts') {
      const cappedReviewIds = await db
        .selectDistinct({
          id: cloud_agent_code_reviews.id,
          created_at: cloud_agent_code_reviews.created_at,
        })
        .from(cloud_agent_code_reviews)
        .innerJoin(
          cloud_agent_code_review_attempts,
          eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
        )
        .where(and(...conditions))
        .orderBy(desc(cloud_agent_code_reviews.created_at))
        .limit(10000);

      if (cappedReviewIds.length === 0) {
        return [];
      }

      return await db
        .select({
          id: cloud_agent_code_reviews.id,
          owned_by_organization_id: cloud_agent_code_reviews.owned_by_organization_id,
          owned_by_user_id: cloud_agent_code_reviews.owned_by_user_id,
          repo_full_name: cloud_agent_code_reviews.repo_full_name,
          pr_number: cloud_agent_code_reviews.pr_number,
          pr_title: cloud_agent_code_reviews.pr_title,
          pr_author: cloud_agent_code_reviews.pr_author,
          status: cloud_agent_code_reviews.status,
          error_message: cloud_agent_code_reviews.error_message,
          terminal_reason: cloud_agent_code_reviews.terminal_reason,
          started_at: cloud_agent_code_reviews.started_at,
          completed_at: cloud_agent_code_reviews.completed_at,
          created_at: cloud_agent_code_reviews.created_at,
          session_id: cloud_agent_code_reviews.session_id,
          attempt_id: cloud_agent_code_review_attempts.id,
          attempt_number: cloud_agent_code_review_attempts.attempt_number,
          retry_of_attempt_id: cloud_agent_code_review_attempts.retry_of_attempt_id,
          retry_reason: cloud_agent_code_review_attempts.retry_reason,
          attempt_status: cloud_agent_code_review_attempts.status,
          attempt_error_message: cloud_agent_code_review_attempts.error_message,
          attempt_terminal_reason: cloud_agent_code_review_attempts.terminal_reason,
          attempt_session_id: cloud_agent_code_review_attempts.session_id,
          attempt_cli_session_id: cloud_agent_code_review_attempts.cli_session_id,
          attempt_started_at: cloud_agent_code_review_attempts.started_at,
          attempt_completed_at: cloud_agent_code_review_attempts.completed_at,
        })
        .from(cloud_agent_code_reviews)
        .innerJoin(
          cloud_agent_code_review_attempts,
          eq(cloud_agent_code_review_attempts.code_review_id, cloud_agent_code_reviews.id)
        )
        .where(
          and(
            inArray(
              cloud_agent_code_reviews.id,
              cappedReviewIds.map(row => row.id)
            ),
            ...conditions
          )
        )
        .orderBy(
          desc(cloud_agent_code_reviews.created_at),
          desc(cloud_agent_code_review_attempts.attempt_number)
        );
    }

    return await db
      .select({
        id: cloud_agent_code_reviews.id,
        owned_by_organization_id: cloud_agent_code_reviews.owned_by_organization_id,
        owned_by_user_id: cloud_agent_code_reviews.owned_by_user_id,
        repo_full_name: cloud_agent_code_reviews.repo_full_name,
        pr_number: cloud_agent_code_reviews.pr_number,
        pr_title: cloud_agent_code_reviews.pr_title,
        pr_author: cloud_agent_code_reviews.pr_author,
        status: cloud_agent_code_reviews.status,
        error_message: cloud_agent_code_reviews.error_message,
        terminal_reason: cloud_agent_code_reviews.terminal_reason,
        started_at: cloud_agent_code_reviews.started_at,
        completed_at: cloud_agent_code_reviews.completed_at,
        created_at: cloud_agent_code_reviews.created_at,
        session_id: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .orderBy(desc(cloud_agent_code_reviews.created_at))
      .limit(10000);
  }),

  // Search users for filter dropdown
  searchUsers: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const result = await db
        .select({
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
          name: kilocode_users.google_user_name,
        })
        .from(kilocode_users)
        .where(
          or(
            ilike(kilocode_users.google_user_email, `%${input.query}%`),
            ilike(kilocode_users.google_user_name, `%${input.query}%`),
            eq(kilocode_users.id, input.query)
          )
        )
        .limit(20);

      return result;
    }),

  // Search organizations for filter dropdown
  searchOrganizations: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const searchTerm = input.query.trim();
      if (!searchTerm) {
        return [];
      }

      const escapedTerm = searchTerm.replace(/[%_\\]/g, '\\$&');
      const ilikePattern = `%${escapedTerm}%`;
      const nameSearchCondition = ilike(organizations.name, ilikePattern);
      const organizationId = z.string().uuid().safeParse(searchTerm);
      const searchCondition = organizationId.success
        ? or(nameSearchCondition, eq(organizations.id, organizationId.data))
        : nameSearchCondition;

      if (!searchCondition) {
        return [];
      }

      const result = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          plan: organizations.plan,
        })
        .from(organizations)
        .where(searchCondition)
        .limit(20);

      return result;
    }),
});
