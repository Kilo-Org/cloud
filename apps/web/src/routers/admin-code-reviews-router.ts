import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { cloud_agent_code_reviews, kilocode_users, organizations } from '@kilocode/db/schema';
import * as z from 'zod';
import { sql, and, gte, lt, eq, isNotNull, isNull, desc, ilike, or, type SQL } from 'drizzle-orm';

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

/**
 * SQL condition to exclude billing errors from failure metrics.
 * Uses COALESCE to handle NULL error_message (NULL NOT LIKE returns NULL, not TRUE).
 */
const excludeBillingErrors = sql`COALESCE(${cloud_agent_code_reviews.terminal_reason}, '') <> 'billing'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%Insufficient credits%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%paid model%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%add credits%'
  AND COALESCE(${cloud_agent_code_reviews.error_message}, '') NOT ILIKE '%Credits Required%'`;

/**
 * Categorize error messages into high-level buckets via SQL CASE WHEN.
 * Pattern matching is ordered from most-specific to least-specific.
 */
const errorCategoryExpr = sql<string>`CASE
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

const FilterSchema = z.object({
  startDate: z.string().date(), // ISO date string YYYY-MM-DD
  endDate: z.string().date(), // ISO date string YYYY-MM-DD
  userId: z.string().min(1).optional(), // Filter by specific user
  organizationId: z.string().uuid().optional(), // Filter by specific organization
  ownershipType: z.enum(['all', 'personal', 'organization']).optional().default('all'),
  agentVersion: z.enum(['all', 'v1', 'v2']).optional().default('all'),
});

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

/** Returns a SQL condition filtering by agent_version, or undefined for 'all'. */
function buildAgentVersionFilter(agentVersion?: 'all' | 'v1' | 'v2'): SQL | undefined {
  if (!agentVersion || agentVersion === 'all') return undefined;
  // NULL agent_version is treated as 'v1' (schema default + existing normalization)
  if (agentVersion === 'v1') {
    return or(
      eq(cloud_agent_code_reviews.agent_version, 'v1'),
      isNull(cloud_agent_code_reviews.agent_version)
    );
  }
  return eq(cloud_agent_code_reviews.agent_version, agentVersion);
}

const ownershipTypeExpr = sql<string>`CASE WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'organization' ELSE 'personal' END`;
const waitSecondsExpr = sql<number>`EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.started_at} - ${cloud_agent_code_reviews.created_at}))`;
const validStartedWaitCondition = sql`${cloud_agent_code_reviews.started_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} >= ${cloud_agent_code_reviews.created_at}`;

export const adminCodeReviewsRouter = createTRPCRouter({
  // Get overview KPIs
  getOverviewStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
      .select({
        total_reviews: sql<number>`COUNT(*)`,
        completed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude billing errors from system failure count — they get their own KPI
        failed_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeBillingErrors})`,
        cancelled_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'cancelled')`,
        interrupted_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'interrupted')`,
        in_progress_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running'))`,
        avg_duration_seconds: sql<number>`AVG(EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))) FILTER (WHERE ${cloud_agent_code_reviews.completed_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} IS NOT NULL)`,
        wait_started_count: sql<number>`COUNT(*) FILTER (WHERE ${validStartedWaitCondition})`,
        avg_wait_seconds: sql<number>`AVG(${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
        p95_wait_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
        p99_wait_seconds: sql<number>`percentile_cont(0.99) WITHIN GROUP (ORDER BY ${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
        max_wait_seconds: sql<number>`MAX(${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
        within_5m_wait_count: sql<number>`COUNT(*) FILTER (WHERE ${validStartedWaitCondition} AND ${cloud_agent_code_reviews.started_at} <= ${cloud_agent_code_reviews.created_at} + INTERVAL '5 minutes')`,
        // Billing errors (402): not system failures, not cancellations — separate bucket
        billing_error_count: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${isBillingError})`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions));

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

    // Per-version breakdown (only when viewing all versions)
    const baseConditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
    ].filter(Boolean) as SQL[];

    const versionBreakdown =
      !agentVersion || agentVersion === 'all'
        ? await db
            .select({
              agent_version: sql<string>`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`,
              total: sql<number>`COUNT(*)`,
              completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
              failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeBillingErrors})`,
              avg_duration_seconds: sql<number>`AVG(EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))) FILTER (WHERE ${cloud_agent_code_reviews.completed_at} IS NOT NULL AND ${cloud_agent_code_reviews.started_at} IS NOT NULL)`,
            })
            .from(cloud_agent_code_reviews)
            .where(and(...baseConditions))
            .groupBy(sql`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`)
        : undefined;

    return {
      totalReviews: total,
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
      versionBreakdown: versionBreakdown?.map(row => ({
        agentVersion: row.agent_version,
        total: Number(row.total) || 0,
        completed: Number(row.completed) || 0,
        failed: Number(row.failed) || 0,
        avgDurationSeconds: Number(row.avg_duration_seconds) || 0,
      })),
    };
  }),

  // Get daily time series data
  getDailyStats: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})::date::text`,
        total: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude billing errors from system failure count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeBillingErrors})`,
        cancelled: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'cancelled')`,
        interrupted: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'interrupted')`,
        in_progress: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running'))`,
        billing_errors: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${isBillingError})`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`)
      .orderBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`);

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
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      eq(cloud_agent_code_reviews.status, 'cancelled'),
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const cancellationReasonExpr = sql<string>`CASE
      WHEN ${cloud_agent_code_reviews.terminal_reason} = 'superseded' OR ${cloud_agent_code_reviews.error_message} ILIKE '%superseded%' THEN 'Superseded by new commit'
      WHEN ${cloud_agent_code_reviews.error_message} ILIKE '%stream timeout%' THEN 'Stream timeout'
      WHEN ${cloud_agent_code_reviews.terminal_reason} = 'user_cancelled' OR ${cloud_agent_code_reviews.error_message} ILIKE '%cancelled%' OR ${cloud_agent_code_reviews.error_message} ILIKE '%canceled%' THEN 'Explicitly cancelled'
      WHEN ${cloud_agent_code_reviews.error_message} ILIKE '%killed%' OR ${cloud_agent_code_reviews.error_message} ILIKE '%sigkill%' OR ${cloud_agent_code_reviews.error_message} ILIKE '%sigterm%' THEN 'Process killed'
      WHEN ${cloud_agent_code_reviews.terminal_reason} = 'interrupted' OR ${cloud_agent_code_reviews.error_message} ILIKE '%interrupted%' THEN 'User interrupted'
      WHEN ${cloud_agent_code_reviews.error_message} IS NULL THEN 'No reason provided'
      ELSE 'Other'
    END`;

    const reasons = await db
      .select({
        reason: cancellationReasonExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${cloud_agent_code_reviews.created_at})::text`,
        last_occurrence: sql<string>`MAX(${cloud_agent_code_reviews.created_at})::text`,
      })
      .from(cloud_agent_code_reviews)
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
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      eq(cloud_agent_code_reviews.status, 'failed'),
      excludeBillingErrors,
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    // Categorized error summary
    const categorized = await db
      .select({
        category: errorCategoryExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${cloud_agent_code_reviews.created_at})::text`,
        last_occurrence: sql<string>`MAX(${cloud_agent_code_reviews.created_at})::text`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(errorCategoryExpr)
      .orderBy(desc(sql`COUNT(*)`));

    // Raw error messages (top 50, for drill-down table)
    const raw = await db
      .select({
        error_type: sql<string>`COALESCE(SUBSTRING(${cloud_agent_code_reviews.error_message} FROM 1 FOR 200), 'Unknown Error')`,
        category: errorCategoryExpr,
        count: sql<number>`COUNT(*)`,
        first_occurrence: sql<string>`MIN(${cloud_agent_code_reviews.created_at})::text`,
        last_occurrence: sql<string>`MAX(${cloud_agent_code_reviews.created_at})::text`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(
        sql`SUBSTRING(${cloud_agent_code_reviews.error_message} FROM 1 FOR 200)`,
        errorCategoryExpr
      )
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
  getErrorSessions: adminProcedure
    .input(FilterSchema.extend({ errorMessage: z.string().min(1) }))
    .query(async ({ input }) => {
      const {
        startDate,
        endDate,
        userId,
        organizationId,
        ownershipType,
        agentVersion,
        errorMessage,
      } = input;
      const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
      const agentVersionFilter = buildAgentVersionFilter(agentVersion);

      const conditions = [
        eq(cloud_agent_code_reviews.status, 'failed'),
        excludeBillingErrors,
        gte(cloud_agent_code_reviews.created_at, startDate),
        lt(cloud_agent_code_reviews.created_at, endDate),
        eq(
          sql`COALESCE(SUBSTRING(${cloud_agent_code_reviews.error_message} FROM 1 FOR 200), 'Unknown Error')`,
          errorMessage
        ),
        ownershipFilter,
        agentVersionFilter,
      ].filter(Boolean) as SQL[];

      const rows = await db
        .select({
          session_id: cloud_agent_code_reviews.session_id,
          cli_session_id: cloud_agent_code_reviews.cli_session_id,
          user_id: cloud_agent_code_reviews.owned_by_user_id,
          org_id: cloud_agent_code_reviews.owned_by_organization_id,
          error_message: cloud_agent_code_reviews.error_message,
          created_at: cloud_agent_code_reviews.created_at,
          repo_full_name: cloud_agent_code_reviews.repo_full_name,
          pr_number: cloud_agent_code_reviews.pr_number,
          agent_version: cloud_agent_code_reviews.agent_version,
        })
        .from(cloud_agent_code_reviews)
        .where(and(...conditions))
        .orderBy(desc(cloud_agent_code_reviews.created_at))
        .limit(20);

      return rows.map(row => ({
        sessionId: row.session_id,
        cliSessionId: row.cli_session_id,
        userId: row.user_id,
        orgId: row.org_id,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        repoFullName: row.repo_full_name,
        prNumber: row.pr_number,
        agentVersion: row.agent_version,
      }));
    }),

  // Get user segmentation (note: this doesn't use filters since it shows top users/orgs for selection)
  getUserSegmentation: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const baseConditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    // Personal vs Org breakdown
    const ownershipBreakdown = await db
      .select({
        ownership_type: ownershipTypeExpr,
        count: sql<number>`COUNT(*)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'completed')`,
        // Exclude billing errors from failed count
        failed: sql<number>`COUNT(*) FILTER (WHERE ${cloud_agent_code_reviews.status} = 'failed' AND ${excludeBillingErrors})`,
        wait_started_count: sql<number>`COUNT(*) FILTER (WHERE ${validStartedWaitCondition})`,
        avg_wait_seconds: sql<number>`AVG(${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
        p95_wait_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSecondsExpr}) FILTER (WHERE ${validStartedWaitCondition})`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...baseConditions))
      .groupBy(ownershipTypeExpr);

    // Top users (only show if not filtering by specific user)
    const topUsers = userId
      ? []
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
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      validStartedWaitCondition,
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const dayExpr = sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`;

    const result = await db
      .select({
        day: sql<string>`${dayExpr}::date::text`,
        ownership_type: ownershipTypeExpr,
        avg_seconds: sql<number>`AVG(${waitSecondsExpr})`,
        p50_seconds: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${waitSecondsExpr})`,
        p95_seconds: sql<number>`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${waitSecondsExpr})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(cloud_agent_code_reviews)
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
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      eq(cloud_agent_code_reviews.status, 'completed'),
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      isNotNull(cloud_agent_code_reviews.completed_at),
      isNotNull(cloud_agent_code_reviews.started_at),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const durationExpr = sql`EXTRACT(EPOCH FROM (${cloud_agent_code_reviews.completed_at}::timestamp - ${cloud_agent_code_reviews.started_at}::timestamp))`;

    const result = await db
      .select({
        day: sql<string>`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})::date::text`,
        agent_version: sql<string>`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`,
        avg_seconds: sql<number>`AVG(${durationExpr})`,
        p50_seconds: sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${durationExpr})`,
        p90_seconds: sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${durationExpr})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .groupBy(
        sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`,
        sql`COALESCE(${cloud_agent_code_reviews.agent_version}, 'v1')`
      )
      .orderBy(sql`DATE_TRUNC('day', ${cloud_agent_code_reviews.created_at})`);

    return result.map(row => ({
      day: row.day,
      agentVersion: row.agent_version,
      avgSeconds: Number(row.avg_seconds) || 0,
      p50Seconds: Number(row.p50_seconds) || 0,
      p90Seconds: Number(row.p90_seconds) || 0,
      count: Number(row.count) || 0,
    }));
  }),

  // Get CSV export data
  getExportData: adminProcedure.input(FilterSchema).query(async ({ input }) => {
    const { startDate, endDate, userId, organizationId, ownershipType, agentVersion } = input;
    const ownershipFilter = buildOwnershipFilter(userId, organizationId, ownershipType);
    const agentVersionFilter = buildAgentVersionFilter(agentVersion);

    const conditions = [
      gte(cloud_agent_code_reviews.created_at, startDate),
      lt(cloud_agent_code_reviews.created_at, endDate),
      ownershipFilter,
      agentVersionFilter,
    ].filter(Boolean) as SQL[];

    const result = await db
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

    return result;
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
