import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { and, asc, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { readDb, usageReadDb } from '@/lib/drizzle';
import { timedUsageQuery } from '@/lib/usage-query';
import {
  feature,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
  mode,
  organization_memberships,
  organizations,
  user_auth_provider,
} from '@kilocode/db/schema';
import type { AuthProviderId } from '@kilocode/db/schema-types';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import {
  ensureOrganizationAccess,
  ensureOrganizationsAccess,
  getOrganizationsAccessRoles,
} from '@/routers/organizations/utils';
import {
  BreakdownInputSchema,
  BreakdownOutputSchema,
  MAX_SCOPE_ORGANIZATION_IDS,
  SummaryOutputSchema,
  TableInputSchema,
  TableOutputSchema,
  TimeseriesInputSchema,
  TimeseriesOutputSchema,
  UsageAnalyticsFiltersSchema,
  type BreakdownDimension,
  type CostSource,
  type Dimension,
  type Granularity,
  type Metric,
  type SummaryOutput,
  type UsageAnalyticsFilters,
} from '@/routers/usage-analytics-schemas';

export {
  BreakdownInputSchema,
  BreakdownDimensionSchema,
  BreakdownOutputSchema,
  CostSourceSchema,
  DimensionSchema,
  GranularitySchema,
  MAX_SCOPE_ORGANIZATION_IDS,
  MetricSchema,
  SummaryOutputSchema,
  TableInputSchema,
  TableOutputSchema,
  TimeseriesInputSchema,
  TimeseriesOutputSchema,
  UsageAnalyticsFiltersSchema,
} from '@/routers/usage-analytics-schemas';
export type {
  BreakdownDimension,
  CostSource,
  Dimension,
  Granularity,
  Metric,
  SummaryOutput,
  UsageAnalyticsFilters,
} from '@/routers/usage-analytics-schemas';

// ---------------------------------------------------------------------------
// Table / tier resolution
// ---------------------------------------------------------------------------

type GranularityTier = 'hourly' | 'daily' | 'monthly';

type TableMeta = {
  tier: GranularityTier;
  /** Effective granularity after auto-downgrade (may differ from requested). */
  effectiveGranularity: Granularity;
};

function resolveTier(granularity: Granularity, startDate: string): TableMeta {
  const now = Date.now();
  const startMs = new Date(startDate).getTime();
  const ageDays = (now - startMs) / (24 * 60 * 60 * 1000);

  if (granularity === 'hour') {
    // Use < 8 rather than <= 7: periodToDateRange('7d') snaps the start to
    // UTC midnight, so ageDays can be up to ~7.99 for a genuine "past week"
    // request. The < 8 threshold keeps all 7-day windows in the hourly tier.
    if (ageDays < 8) {
      return { tier: 'hourly', effectiveGranularity: 'hour' };
    }
    // Auto-downgrade: hourly buckets are only used for the past 7 days.
    return { tier: 'daily', effectiveGranularity: 'day' };
  }

  if (granularity === 'day' || granularity === 'week') {
    return { tier: 'daily', effectiveGranularity: granularity };
  }

  return { tier: 'monthly', effectiveGranularity: 'month' };
}

// ---------------------------------------------------------------------------
// SQL WHERE clause builder
// ---------------------------------------------------------------------------

/**
 * Accumulates SQL WHERE clauses. Callers push conditions in any order;
 * `toSQL()` joins them with AND.
 */
export class WhereBuilder {
  readonly conditions: SQL[] = [];

  add(condition: SQL): void {
    this.conditions.push(condition);
  }

  toSQL(): SQL | undefined {
    return this.conditions.length > 0 ? and(...this.conditions) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** True when the filters target one or more organizations (vs personal usage). */
function isOrgScope(filters: UsageAnalyticsFilters): boolean {
  return Boolean(filters.organizationId) || (filters.organizationIds?.length ?? 0) > 0;
}

async function ensureScopeAccess(ctx: TRPCContext, filters: UsageAnalyticsFilters): Promise<void> {
  const userId = ctx.user.id;

  // Multi-org aggregate ("All Organizations"): always org-wide, and the caller
  // must be owner/billing_manager of every org in the list. A parent owner has
  // inherited owner/billing access to children, so this passes for the parent
  // plus all of its children while rejecting any org they cannot administer.
  // Batched into a fixed number of queries so a large org list cannot fan out
  // into one authorization query per id.
  if (filters.organizationIds && filters.organizationIds.length > 0) {
    await ensureOrganizationsAccess(ctx, filters.organizationIds, ORGANIZATION_BILLING_ROLES);
    return;
  }

  if (filters.organizationId) {
    const requiredRoles = filters.viewAs === 'org-wide' ? ORGANIZATION_BILLING_ROLES : undefined;
    await ensureOrganizationAccess(ctx, filters.organizationId, requiredRoles);

    if (filters.viewAs === 'self') {
      const allUserFilterValues = [...(filters.userIds ?? []), ...(filters.excludedUserIds ?? [])];
      if (allUserFilterValues.some(v => v !== userId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Self-scope analytics can only filter to own user.',
        });
      }
    }
    return;
  }

  const allUserFilterValues = [...(filters.userIds ?? []), ...(filters.excludedUserIds ?? [])];
  if (allUserFilterValues.some(v => v !== userId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Personal analytics can only filter to own user.',
    });
  }
}

// ---------------------------------------------------------------------------
// WHERE clause helpers
// ---------------------------------------------------------------------------

function buildDateConditions(where: WhereBuilder, filters: UsageAnalyticsFilters): void {
  where.add(gte(microdollar_usage.created_at, filters.startDate));
  where.add(lt(microdollar_usage.created_at, filters.endDate));
}

export function buildScopeConditions(
  where: WhereBuilder,
  filters: UsageAnalyticsFilters,
  ctxUserId: string
): void {
  if (filters.organizationIds && filters.organizationIds.length > 0) {
    // Aggregate across the parent org and its children. Always org-wide, so
    // honor any explicit user include/exclude filters but never pin to self.
    where.add(inArray(microdollar_usage.organization_id, filters.organizationIds));
    if (filters.userIds && filters.userIds.length > 0) {
      where.add(inArray(microdollar_usage.kilo_user_id, filters.userIds));
    }
    if (filters.excludedUserIds && filters.excludedUserIds.length > 0) {
      where.add(notInArray(microdollar_usage.kilo_user_id, filters.excludedUserIds));
    }
    return;
  }
  if (filters.organizationId) {
    where.add(eq(microdollar_usage.organization_id, filters.organizationId));
    if (filters.viewAs === 'self') {
      where.add(eq(microdollar_usage.kilo_user_id, ctxUserId));
    } else {
      if (filters.userIds && filters.userIds.length > 0) {
        where.add(inArray(microdollar_usage.kilo_user_id, filters.userIds));
      }
      if (filters.excludedUserIds && filters.excludedUserIds.length > 0) {
        where.add(notInArray(microdollar_usage.kilo_user_id, filters.excludedUserIds));
      }
    }
  } else {
    where.add(eq(microdollar_usage.kilo_user_id, ctxUserId));
    if (filters.personalScope === 'personal-only') {
      // Personal usage is stored with a NULL organization_id.
      where.add(isNull(microdollar_usage.organization_id));
    }
  }
}

const featureName: SQL<string> = sql<string>`COALESCE(${feature.feature}, '')`;
const modeName: SQL<string> = sql<string>`COALESCE(${mode.mode}, '')`;
const modelName: SQL<string> = sql<string>`COALESCE(${microdollar_usage.model}, '')`;
const providerName: SQL<string> = sql<string>`COALESCE(${microdollar_usage.provider}, '')`;
const projectName: SQL<string> = sql<string>`COALESCE(${microdollar_usage.project_id}, '')`;

function inValues(column: SQL, values: string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map(value => sql`${value}`),
    sql`, `
  )})`;
}

function notInValues(column: SQL, values: string[]): SQL {
  return sql`${column} NOT IN (${sql.join(
    values.map(value => sql`${value}`),
    sql`, `
  )})`;
}

function buildDimensionConditions(where: WhereBuilder, filters: UsageAnalyticsFilters): void {
  const addInIfNonEmpty = (column: SQL, values: string[] | undefined) => {
    if (values && values.length > 0) where.add(inValues(column, values));
  };
  const addNotInIfNonEmpty = (column: SQL, values: string[] | undefined) => {
    if (values && values.length > 0) where.add(notInValues(column, values));
  };

  addInIfNonEmpty(featureName, filters.features);
  addInIfNonEmpty(modelName, filters.models);
  addInIfNonEmpty(modeName, filters.modes);
  addInIfNonEmpty(providerName, filters.providers);
  addInIfNonEmpty(projectName, filters.projects);
  addNotInIfNonEmpty(featureName, filters.excludedFeatures);
  addNotInIfNonEmpty(modelName, filters.excludedModels);
  addNotInIfNonEmpty(modeName, filters.excludedModes);
  addNotInIfNonEmpty(providerName, filters.excludedProviders);
  addNotInIfNonEmpty(projectName, filters.excludedProjects);
}

function buildWhereClause(
  filters: UsageAnalyticsFilters,
  ctxUserId: string,
  includeDimensions: boolean
): WhereBuilder {
  const where = new WhereBuilder();
  buildDateConditions(where, filters);
  buildScopeConditions(where, filters, ctxUserId);
  if (includeDimensions) {
    buildDimensionConditions(where, filters);
  }
  return where;
}

// ---------------------------------------------------------------------------
// Metric SQL expression
// ---------------------------------------------------------------------------

export function costColumnFor(costSource: CostSource): SQL<number> {
  switch (costSource) {
    case 'cost':
      return sql<number>`${microdollar_usage.cost}`;
    case 'market':
      return sql<number>`COALESCE(${microdollar_usage_metadata.market_cost}, 0)`;
  }
}

export function costSumExprSql(costSource: CostSource): SQL<number> {
  return sql<number>`COALESCE(SUM(${costColumnFor(costSource)}), 0)`;
}

const requestCountExpr = sql<number>`COUNT(*)`;
const inputTokensExpr = sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens}), 0)`;
const outputTokensExpr = sql<number>`COALESCE(SUM(${microdollar_usage.output_tokens}), 0)`;
const cacheWriteTokensExpr = sql<number>`COALESCE(SUM(${microdollar_usage.cache_write_tokens}), 0)`;
const cacheHitTokensExpr = sql<number>`COALESCE(SUM(${microdollar_usage.cache_hit_tokens}), 0)`;
const totalTokensExpr = sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens} + ${microdollar_usage.cache_write_tokens} + ${microdollar_usage.cache_hit_tokens}), 0)`;
const errorCountExpr = sql<number>`COUNT(*) FILTER (WHERE ${microdollar_usage.has_error})`;
const cancelledCountExpr = sql<number>`COUNT(*) FILTER (WHERE ${microdollar_usage_metadata.cancelled})`;
const freeRequestCountExpr = sql<number>`COUNT(*) FILTER (WHERE ${microdollar_usage_metadata.is_free})`;
const byokRequestCountExpr = sql<number>`COUNT(*) FILTER (WHERE ${microdollar_usage_metadata.is_user_byok})`;
const totalLatencyMsExpr = sql<number>`COALESCE(SUM(${microdollar_usage_metadata.latency}), 0)`;
const latencyCountExpr = sql<number>`COUNT(${microdollar_usage_metadata.latency})`;
const totalGenerationTimeMsExpr = sql<number>`COALESCE(SUM(${microdollar_usage_metadata.generation_time}), 0)`;
const generationTimeCountExpr = sql<number>`COUNT(${microdollar_usage_metadata.generation_time})`;

function metricExprSql(metric: Metric, costSource: CostSource): SQL<number> {
  const costSumExpr = costSumExprSql(costSource);
  switch (metric) {
    case 'cost':
      return costSumExpr;
    case 'requests':
      return sql<number>`COALESCE(${requestCountExpr}, 0)`;
    case 'inputTokens':
      return inputTokensExpr;
    case 'outputTokens':
      return outputTokensExpr;
    case 'tokens':
      return totalTokensExpr;
    case 'errorRate':
      return sql<number>`CASE WHEN ${requestCountExpr} = 0 THEN 0 ELSE (${errorCountExpr})::FLOAT / (${requestCountExpr})::FLOAT END`;
    case 'avgLatencyMs':
      return sql<number>`CASE WHEN ${latencyCountExpr} = 0 THEN 0 ELSE (${totalLatencyMsExpr})::FLOAT / (${latencyCountExpr})::FLOAT END`;
    case 'avgGenerationTimeMs':
      return sql<number>`CASE WHEN ${generationTimeCountExpr} = 0 THEN 0 ELSE (${totalGenerationTimeMsExpr})::FLOAT / (${generationTimeCountExpr})::FLOAT END`;
    case 'costPerRequest':
      return sql<number>`CASE WHEN ${requestCountExpr} = 0 THEN 0 ELSE (${costSumExpr})::FLOAT / (${requestCountExpr})::FLOAT END`;
    case 'tokensPerRequest':
      return sql<number>`CASE WHEN ${requestCountExpr} = 0 THEN 0 ELSE (${totalTokensExpr})::FLOAT / (${requestCountExpr})::FLOAT END`;
    case 'cacheHitRatio':
      return sql<number>`CASE WHEN COALESCE(SUM(${microdollar_usage.input_tokens} + ${microdollar_usage.cache_hit_tokens}), 0) = 0 THEN 0 ELSE COALESCE(SUM(${microdollar_usage.cache_hit_tokens}), 0)::FLOAT / SUM(${microdollar_usage.input_tokens} + ${microdollar_usage.cache_hit_tokens})::FLOAT END`;
    case 'outputInputRatio':
      return sql<number>`CASE WHEN COALESCE(SUM(${microdollar_usage.input_tokens}), 0) = 0 THEN 0 ELSE COALESCE(SUM(${microdollar_usage.output_tokens}), 0)::FLOAT / SUM(${microdollar_usage.input_tokens})::FLOAT END`;
  }
}

// ---------------------------------------------------------------------------
// Bucket expression for timeseries / table grouping
// ---------------------------------------------------------------------------

/**
 * Returns a SQL expression that formats the time column as a string bucket,
 * matching the granularity the caller requested.
 *
 * Hourly  → 'YYYY-MM-DD HH24:MI:SS'  (matches what Postgres timestamp::text returns)
 * Day     → 'YYYY-MM-DD'
 * Week    → 'YYYY-MM-DD' of the Monday-aligned week start
 * Month   → 'YYYY-MM-DD' of the first of the month
 */
function bucketExprSql(effectiveGranularity: Granularity): SQL<string> {
  const createdAtUtc = sql`${microdollar_usage.created_at} AT TIME ZONE 'UTC'`;
  if (effectiveGranularity === 'hour') {
    return sql<string>`TO_CHAR(DATE_TRUNC('hour', ${createdAtUtc}), 'YYYY-MM-DD HH24:MI:SS')`;
  }
  if (effectiveGranularity === 'week') {
    return sql<string>`TO_CHAR(DATE_TRUNC('week', ${createdAtUtc}), 'YYYY-MM-DD')`;
  }
  if (effectiveGranularity === 'month') {
    return sql<string>`TO_CHAR(DATE_TRUNC('month', ${createdAtUtc}), 'YYYY-MM-DD')`;
  }
  // 'day'
  return sql<string>`TO_CHAR(DATE_TRUNC('day', ${createdAtUtc}), 'YYYY-MM-DD')`;
}

// ---------------------------------------------------------------------------
// Dimension column name
// ---------------------------------------------------------------------------

export function dimensionColumn(dimension: BreakdownDimension): SQL<string> {
  switch (dimension) {
    case 'feature':
      return featureName;
    case 'model':
      return modelName;
    case 'mode':
      return modeName;
    case 'user':
      return sql<string>`${microdollar_usage.kilo_user_id}`;
    case 'provider':
      return providerName;
    case 'project':
      return projectName;
    case 'organization':
      return sql<string>`COALESCE(${microdollar_usage.organization_id}::text, '')`;
  }
}

const usageMetadataJoin = eq(microdollar_usage.id, microdollar_usage_metadata.id);
const usageFeatureJoin = eq(microdollar_usage_metadata.feature_id, feature.feature_id);
const usageModeJoin = eq(microdollar_usage_metadata.mode_id, mode.mode_id);

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

function ratioSafe(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Convert an aggregate value (often returned as a string by Postgres) to a
 * JS number. Values above `MAX_SAFE_INTEGER` are logged as a warning but still
 * returned so the UI does not crash.
 */
function toSafeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `usage-analytics: aggregate ${String(value)} exceeds Number.MAX_SAFE_INTEGER; precision lost.`
    );
  }
  return n;
}

// ---------------------------------------------------------------------------
// User list (for org context)
// ---------------------------------------------------------------------------

const MAX_USER_LABEL_LOOKUP_IDS = 1_000;

const UserListInputSchema = z.object({
  organizationIds: z.array(z.uuid()).min(1).max(MAX_SCOPE_ORGANIZATION_IDS),
  userIds: z.array(z.string()).max(MAX_USER_LABEL_LOOKUP_IDS),
});

const UserListOutputSchema = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
    })
  ),
});

// ---------------------------------------------------------------------------
// Scope organizations (org usage page Scope selector)
// ---------------------------------------------------------------------------

const ScopeOrganizationsInputSchema = z.object({
  organizationId: z.uuid(),
});

const ScopeOrganizationSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
});

const ScopeOrganizationsOutputSchema = z.object({
  organizationId: z.string(),
  organizationName: z.string(),
  /** Direct child organizations, sorted by name. Empty when not a parent org. */
  children: z.array(ScopeOrganizationSchema),
});

function parseLegacyOAuthUserId(
  userId: string
): { provider: AuthProviderId; providerAccountId: string } | null {
  if (!userId.startsWith('oauth/')) return null;
  const separatorIndex = userId.indexOf(':');
  if (separatorIndex <= 'oauth/'.length) return null;

  const provider = userId.slice('oauth/'.length, separatorIndex);
  const providerAccountId = userId.slice(separatorIndex + 1);
  if (providerAccountId === '') return null;

  switch (provider) {
    case 'apple':
    case 'email':
    case 'google':
    case 'github':
    case 'gitlab':
    case 'linkedin':
    case 'discord':
    case 'fake-login':
    case 'workos':
      return { provider, providerAccountId };
    default:
      return null;
  }
}

function legacyOAuthProviderKey(provider: AuthProviderId, providerAccountId: string): string {
  return `${provider}:${providerAccountId}`;
}

function queryScope(input: UsageAnalyticsFilters): 'org' | 'user' {
  return isOrgScope(input) ? 'org' : 'user';
}

function queryPeriod(input: UsageAnalyticsFilters): string {
  return `${input.startDate}/${input.endDate}`;
}

// ---------------------------------------------------------------------------
// Router definition
// ---------------------------------------------------------------------------

export const usageAnalyticsRouter = createTRPCRouter({
  getSummary: baseProcedure
    .input(UsageAnalyticsFiltersSchema)
    .output(SummaryOutputSchema)
    .query(async ({ input, ctx }): Promise<SummaryOutput> => {
      await ensureScopeAccess(ctx, input);

      const meta = resolveTier(input.granularity, input.startDate);
      const where = buildWhereClause(input, ctx.user.id, true);

      const rows = await timedUsageQuery(
        {
          db: usageReadDb,
          route: 'usageAnalytics.getSummary',
          queryLabel: `summary_${meta.tier}`,
          scope: queryScope(input),
          period: queryPeriod(input),
        },
        tx =>
          tx
            .select({
              costMicrodollars: costSumExprSql(input.costSource),
              requestCount: requestCountExpr,
              inputTokens: inputTokensExpr,
              outputTokens: outputTokensExpr,
              cacheWriteTokens: cacheWriteTokensExpr,
              cacheHitTokens: cacheHitTokensExpr,
              errorCount: errorCountExpr,
              cancelledCount: cancelledCountExpr,
              freeRequestCount: freeRequestCountExpr,
              byokRequestCount: byokRequestCountExpr,
              totalLatencyMs: totalLatencyMsExpr,
              totalGenerationTimeMs: totalGenerationTimeMsExpr,
              latencyCount: latencyCountExpr,
              generationTimeCount: generationTimeCountExpr,
              totalTokens: totalTokensExpr,
              distinctUsers: sql<number>`COUNT(DISTINCT ${microdollar_usage.kilo_user_id})`,
            })
            .from(microdollar_usage)
            .leftJoin(microdollar_usage_metadata, usageMetadataJoin)
            .leftJoin(feature, usageFeatureJoin)
            .leftJoin(mode, usageModeJoin)
            .where(where.toSQL())
      );

      const row = rows[0];
      const costMicrodollars = toSafeNumber(row?.costMicrodollars);
      const requestCount = toSafeNumber(row?.requestCount);
      const inputTokens = toSafeNumber(row?.inputTokens);
      const outputTokens = toSafeNumber(row?.outputTokens);
      const cacheWriteTokens = toSafeNumber(row?.cacheWriteTokens);
      const cacheHitTokens = toSafeNumber(row?.cacheHitTokens);
      const errorCount = toSafeNumber(row?.errorCount);
      const cancelledCount = toSafeNumber(row?.cancelledCount);
      const freeRequestCount = toSafeNumber(row?.freeRequestCount);
      const byokRequestCount = toSafeNumber(row?.byokRequestCount);
      const totalLatencyMs = toSafeNumber(row?.totalLatencyMs);
      const totalGenerationTimeMs = toSafeNumber(row?.totalGenerationTimeMs);
      const latencyCount = toSafeNumber(row?.latencyCount);
      const generationTimeCount = toSafeNumber(row?.generationTimeCount);
      const totalTokens = toSafeNumber(row?.totalTokens);
      const distinctUsers = toSafeNumber(row?.distinctUsers);

      return {
        costMicrodollars,
        requestCount,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheHitTokens,
        errorCount,
        cancelledCount,
        freeRequestCount,
        byokRequestCount,
        totalLatencyMs,
        totalGenerationTimeMs,
        latencyCount,
        generationTimeCount,
        totalTokens,
        distinctUsers,
        errorRate: ratioSafe(errorCount, requestCount),
        avgLatencyMs: ratioSafe(totalLatencyMs, latencyCount),
        avgGenerationTimeMs: ratioSafe(totalGenerationTimeMs, generationTimeCount),
        costPerRequest: ratioSafe(costMicrodollars, requestCount),
        tokensPerRequest: ratioSafe(totalTokens, requestCount),
        cacheHitRatio: ratioSafe(cacheHitTokens, inputTokens + cacheHitTokens),
        outputInputRatio: ratioSafe(outputTokens, inputTokens),
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  getTimeseries: baseProcedure
    .input(TimeseriesInputSchema)
    .output(TimeseriesOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureScopeAccess(ctx, input);

      const meta = resolveTier(input.granularity, input.startDate);
      const bucketExpr = bucketExprSql(meta.effectiveGranularity);
      const metricExpr = metricExprSql(input.metric, input.costSource);
      const where = buildWhereClause(input, ctx.user.id, true);
      const splitCol = input.splitBy ? dimensionColumn(input.splitBy) : undefined;

      const rows = await timedUsageQuery(
        {
          db: usageReadDb,
          route: 'usageAnalytics.getTimeseries',
          queryLabel: `timeseries_${meta.tier}${input.splitBy ? `_split_${input.splitBy}` : ''}`,
          scope: queryScope(input),
          period: queryPeriod(input),
        },
        tx => {
          const query = tx
            .select({
              datetime: bucketExpr,
              value: metricExpr,
              label: splitCol ?? sql<string | null>`CAST(NULL AS TEXT)`,
            })
            .from(microdollar_usage)
            .leftJoin(microdollar_usage_metadata, usageMetadataJoin)
            .leftJoin(feature, usageFeatureJoin)
            .leftJoin(mode, usageModeJoin)
            .where(where.toSQL());

          return splitCol
            ? query.groupBy(bucketExpr, splitCol).orderBy(bucketExpr)
            : query.groupBy(bucketExpr).orderBy(bucketExpr);
        }
      );

      return {
        timeseries: rows.map(row => ({
          datetime: row.datetime ?? '',
          value: toSafeNumber(row.value),
          label: input.splitBy ? (row.label ?? undefined) : undefined,
        })),
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  getBreakdown: baseProcedure
    .input(BreakdownInputSchema)
    .output(BreakdownOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureScopeAccess(ctx, input);

      const meta = resolveTier(input.granularity, input.startDate);
      const dimCol = dimensionColumn(input.dimension);
      const metricExpr = metricExprSql(input.metric, input.costSource);
      const where = buildWhereClause(input, ctx.user.id, true);

      const rows = await timedUsageQuery(
        {
          db: usageReadDb,
          route: 'usageAnalytics.getBreakdown',
          queryLabel: `breakdown_${meta.tier}_by_${input.dimension}`,
          scope: queryScope(input),
          period: queryPeriod(input),
        },
        tx =>
          tx
            .select({
              key: dimCol,
              value: metricExpr,
            })
            .from(microdollar_usage)
            .leftJoin(microdollar_usage_metadata, usageMetadataJoin)
            .leftJoin(feature, usageFeatureJoin)
            .leftJoin(mode, usageModeJoin)
            .where(where.toSQL())
            .groupBy(dimCol)
            .orderBy(sql`${metricExpr} DESC`)
            .limit(input.limit)
      );

      const values = rows.map(row => ({ key: row.key ?? '', value: toSafeNumber(row.value) }));
      // Percentages are relative to the *returned* rows (limited by input.limit).
      // They will not reflect the true share when the result set is capped.
      const totalValue = values.reduce((s, r) => s + r.value, 0);

      return {
        breakdown: values.map(r => ({
          key: r.key,
          label: r.key,
          value: r.value,
          percentage: totalValue > 0 ? (r.value / totalValue) * 100 : 0,
        })),
        totalValue,
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  getTable: baseProcedure
    .input(TableInputSchema)
    .output(TableOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureScopeAccess(ctx, input);

      const meta = resolveTier(input.granularity, input.startDate);
      const bucketExpr = bucketExprSql(meta.effectiveGranularity);
      const where = buildWhereClause(input, ctx.user.id, true);
      const requestedDims = input.groupBy;

      // For dimensions not in groupBy, emit an empty string constant so the
      // row shape stays stable regardless of which dimensions were requested.
      const featExpr = requestedDims.includes('feature') ? featureName : sql<string>`''`;
      const modelExpr = requestedDims.includes('model') ? modelName : sql<string>`''`;
      const modeExpr = requestedDims.includes('mode') ? modeName : sql<string>`''`;
      const userExpr = requestedDims.includes('user')
        ? sql<string>`${microdollar_usage.kilo_user_id}`
        : sql<string>`''`;
      const providerExpr = requestedDims.includes('provider') ? providerName : sql<string>`''`;
      const projectExpr = requestedDims.includes('project') ? projectName : sql<string>`''`;

      // GROUP BY columns: bucket + each requested dimension column
      const dimGroupBy = requestedDims.map(d => dimensionColumn(d));
      const groupByClause = [bucketExpr, ...dimGroupBy];

      const rows = await timedUsageQuery(
        {
          db: usageReadDb,
          route: 'usageAnalytics.getTable',
          queryLabel: `table_${meta.tier}_groupby_${requestedDims.join('+') || 'none'}`,
          scope: queryScope(input),
          period: queryPeriod(input),
        },
        tx =>
          tx
            .select({
              datetime: bucketExpr,
              dimFeature: featExpr,
              dimModel: modelExpr,
              dimMode: modeExpr,
              dimUser: userExpr,
              dimProvider: providerExpr,
              dimProject: projectExpr,
              costMicrodollars: costSumExprSql(input.costSource),
              requestCount: requestCountExpr,
              inputTokens: inputTokensExpr,
              outputTokens: outputTokensExpr,
              cacheWriteTokens: cacheWriteTokensExpr,
              cacheHitTokens: cacheHitTokensExpr,
              errorCount: errorCountExpr,
            })
            .from(microdollar_usage)
            .leftJoin(microdollar_usage_metadata, usageMetadataJoin)
            .leftJoin(feature, usageFeatureJoin)
            .leftJoin(mode, usageModeJoin)
            .where(where.toSQL())
            .groupBy(...groupByClause)
            .orderBy(sql`${bucketExpr} DESC`)
            .limit(input.limit)
      );

      return {
        rows: rows.map(row => {
          const dimensions: Record<string, string> = {};
          for (const d of requestedDims) {
            const raw = {
              feature: row.dimFeature,
              model: row.dimModel,
              mode: row.dimMode,
              user: row.dimUser,
              provider: row.dimProvider,
              project: row.dimProject,
            }[d];
            dimensions[d] = typeof raw === 'string' ? raw : '';
          }
          return {
            datetime: row.datetime ?? '',
            dimensions,
            costMicrodollars: toSafeNumber(row.costMicrodollars),
            requestCount: toSafeNumber(row.requestCount),
            inputTokens: toSafeNumber(row.inputTokens),
            outputTokens: toSafeNumber(row.outputTokens),
            cacheWriteTokens: toSafeNumber(row.cacheWriteTokens),
            cacheHitTokens: toSafeNumber(row.cacheHitTokens),
            errorCount: toSafeNumber(row.errorCount),
          };
        }),
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  /**
   * Returns the org plus its direct child organizations, for the org usage
   * page's Scope selector. Restricted to owner/billing_manager because that is
   * who may view org-wide usage and (via inheritance) child-org usage. Members
   * never see the expanded scope list, so they cannot enumerate children here.
   */
  getScopeOrganizations: baseProcedure
    .input(ScopeOrganizationsInputSchema)
    .output(ScopeOrganizationsOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_BILLING_ROLES);

      const [org] = await readDb
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(and(eq(organizations.id, input.organizationId), isNull(organizations.deleted_at)))
        .limit(1);

      if (!org) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      // Exclude soft-deleted children so they never appear in the scope list or
      // get folded into the All Organizations aggregate.
      const children = await readDb
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(
          and(
            eq(organizations.parent_organization_id, input.organizationId),
            isNull(organizations.deleted_at)
          )
        )
        .orderBy(asc(organizations.name));

      return {
        organizationId: org.id,
        organizationName: org.name,
        children: children.map(child => ({
          organizationId: child.id,
          organizationName: child.name,
        })),
      };
    }),

  /**
   * Look up user names and emails for a set of user IDs that belong to the
   * given orgs. Used by the UI to decorate per-user breakdowns, filters, and
   * table rows — including the multi-org "All Organizations" aggregate view,
   * where a parent owner resolves users across the parent and its children.
   *
   * Only returns users that are members of one of `organizationIds` to prevent
   * callers from enumerating arbitrary kilocode_users PII.
   *
   * Callers who are not owner/billing_manager of *every* requested org can only
   * resolve their own id — they have no legitimate need to see other members'
   * name/email from this endpoint.
   */
  resolveOrgUsers: baseProcedure
    .input(UserListInputSchema)
    .output(UserListOutputSchema)
    .query(async ({ input, ctx }) => {
      const accessByOrg = await getOrganizationsAccessRoles(ctx, input.organizationIds);

      // Require access to every requested org (mirrors the single-org guard).
      const hasAccessToAll = input.organizationIds.every(orgId => accessByOrg.has(orgId));
      if (!hasAccessToAll) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'You do not have access to this organization',
        });
      }

      // Only owner/billing_manager of *every* requested org may resolve other
      // members; anyone else can resolve only their own id.
      const canSeeAllMembers = input.organizationIds.every(orgId => {
        const role = accessByOrg.get(orgId);
        return role === 'owner' || role === 'billing_manager';
      });
      const allowedIds = canSeeAllMembers
        ? input.userIds
        : input.userIds.filter(id => id === ctx.user.id);

      if (allowedIds.length === 0) return { users: [] };

      const rows = await readDb
        .select({
          id: kilocode_users.id,
          name: kilocode_users.google_user_name,
          email: kilocode_users.google_user_email,
        })
        .from(kilocode_users)
        .innerJoin(
          organization_memberships,
          and(
            eq(organization_memberships.kilo_user_id, kilocode_users.id),
            inArray(organization_memberships.organization_id, input.organizationIds)
          )
        )
        .where(inArray(kilocode_users.id, allowedIds));

      const usersById = new Map(
        rows.map(r => [
          r.id,
          {
            id: r.id,
            name: r.name,
            email: r.email,
          },
        ])
      );

      const legacyLookups = allowedIds
        .filter(id => !usersById.has(id))
        .map(id => ({ id, parsed: parseLegacyOAuthUserId(id) }))
        .filter((lookup): lookup is { id: string; parsed: NonNullable<typeof lookup.parsed> } =>
          Boolean(lookup.parsed)
        );

      if (legacyLookups.length > 0) {
        const legacyIdsByProviderKey = new Map(
          legacyLookups.map(lookup => [
            legacyOAuthProviderKey(lookup.parsed.provider, lookup.parsed.providerAccountId),
            lookup.id,
          ])
        );
        const legacyConditions = legacyLookups.map(lookup =>
          and(
            eq(user_auth_provider.provider, lookup.parsed.provider),
            eq(user_auth_provider.provider_account_id, lookup.parsed.providerAccountId)
          )
        );
        const legacyWhere = or(...legacyConditions);

        if (legacyWhere) {
          const legacyRows = await readDb
            .select({
              provider: user_auth_provider.provider,
              providerAccountId: user_auth_provider.provider_account_id,
              name: kilocode_users.google_user_name,
              email: kilocode_users.google_user_email,
            })
            .from(user_auth_provider)
            .innerJoin(kilocode_users, eq(user_auth_provider.kilo_user_id, kilocode_users.id))
            .innerJoin(
              organization_memberships,
              and(
                eq(organization_memberships.kilo_user_id, user_auth_provider.kilo_user_id),
                inArray(organization_memberships.organization_id, input.organizationIds)
              )
            )
            .where(legacyWhere);

          for (const row of legacyRows) {
            const id = legacyIdsByProviderKey.get(
              legacyOAuthProviderKey(row.provider, row.providerAccountId)
            );
            if (!id) continue;
            usersById.set(id, {
              id,
              name: row.name,
              email: row.email,
            });
          }
        }
      }

      return {
        users: allowedIds.flatMap(id => {
          const user = usersById.get(id);
          return user ? [user] : [];
        }),
      };
    }),
});
