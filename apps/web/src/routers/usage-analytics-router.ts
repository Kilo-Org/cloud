import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { readDb } from '@/lib/drizzle';
import { getEnvVariable } from '@/lib/dotenvx';
import {
  executeSnowflakeStatement,
  resolveSnowflakeConfig,
  type SnowflakeBinding,
} from '@/lib/snowflake';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

export const GranularitySchema = z.enum(['hour', 'day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const DimensionSchema = z.enum(['feature', 'model', 'mode', 'user', 'provider', 'project']);
export type Dimension = z.infer<typeof DimensionSchema>;

export const MetricSchema = z.enum([
  'cost',
  'requests',
  'tokens',
  'inputTokens',
  'outputTokens',
  'errorRate',
  'avgLatencyMs',
  'avgGenerationTimeMs',
  'costPerRequest',
  'tokensPerRequest',
  'cacheHitRatio',
  'outputInputRatio',
]);
export type Metric = z.infer<typeof MetricSchema>;

const FiltersShape = {
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  granularity: GranularitySchema,
  organizationId: z.uuid().optional(),
  /**
   * Personal-scope narrowing:
   * - 'personal-only' (default) → organization_id IS NULL
   * - 'include-orgs'            → any organization (including personal)
   * Ignored when `organizationId` is set (org scope always filters by that org).
   */
  personalScope: z.enum(['personal-only', 'include-orgs']).default('personal-only'),
  /**
   * Org-scope narrowing when `organizationId` is set:
   * - 'self'     (default) → restricts to ctx.user.id within the organization
   * - 'org-wide'           → all users in the org; requires owner/billing_manager
   * Ignored when `organizationId` is not set.
   */
  viewAs: z.enum(['self', 'org-wide']).default('self'),
  features: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  modes: z.array(z.string()).optional(),
  userIds: z.array(z.string()).optional(),
  providers: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
  excludedFeatures: z.array(z.string()).optional(),
  excludedModels: z.array(z.string()).optional(),
  excludedModes: z.array(z.string()).optional(),
  excludedUserIds: z.array(z.string()).optional(),
  excludedProviders: z.array(z.string()).optional(),
  excludedProjects: z.array(z.string()).optional(),
} as const;

const UsageAnalyticsFiltersSchema = z.object(FiltersShape);
export type UsageAnalyticsFilters = z.infer<typeof UsageAnalyticsFiltersSchema>;

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
    // Auto-downgrade: hourly data is only available for the past 7 days.
    return { tier: 'daily', effectiveGranularity: 'day' };
  }

  if (granularity === 'day' || granularity === 'week') {
    // MICRODOLLAR_USAGE_DAILY holds full history — no age-based downgrade needed.
    return { tier: 'daily', effectiveGranularity: granularity };
  }

  return { tier: 'monthly', effectiveGranularity: 'month' };
}

/**
 * Returns the Snowflake table name for a given tier.
 * Both daily and monthly tiers use MICRODOLLAR_USAGE_DAILY; monthly queries
 * add a DATE_TRUNC('MONTH', usage_day) bucket expression on top.
 */
function getTableName(tier: GranularityTier): string {
  return tier === 'hourly' ? 'MICRODOLLAR_USAGE_HOURLY' : 'MICRODOLLAR_USAGE_DAILY';
}

/** The column that holds the time value for a given tier. */
function getTimeColumn(tier: GranularityTier): string {
  return tier === 'hourly' ? 'usage_hour' : 'usage_date';
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function ceilIsoToUtcDayExclusive(iso: string): string {
  const d = new Date(iso);
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (d.getTime() === dayStartMs) {
    return iso.slice(0, 10);
  }
  return new Date(dayStartMs + 86_400_000).toISOString().slice(0, 10);
}

function floorIsoToUtcMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function ceilIsoToUtcMonthExclusive(iso: string): string {
  const d = new Date(iso);
  const firstOfMonthMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (d.getTime() === firstOfMonthMs) {
    return iso.slice(0, 10);
  }
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// SQL WHERE clause builder
// ---------------------------------------------------------------------------

/**
 * Accumulates SQL WHERE clauses with positional `?` bindings.
 * Callers push conditions in any order; `sql()` joins them with AND.
 */
class WhereBuilder {
  readonly clauses: string[] = [];
  readonly bindings: SnowflakeBinding[] = [];

  private push(clause: string, ...bindings: SnowflakeBinding[]) {
    bindings.forEach(b => this.bindings.push(b));
    this.clauses.push(clause);
  }

  addTimestampRange(column: string, gte: string, lt: string): void {
    this.push(
      `${column} >= ? AND ${column} < ?`,
      { type: 'TEXT', value: gte },
      { type: 'TEXT', value: lt }
    );
  }

  addDateRange(column: string, gte: string, lt: string): void {
    this.push(
      `${column} >= ? AND ${column} < ?`,
      { type: 'TEXT', value: gte },
      { type: 'TEXT', value: lt }
    );
  }

  addEq(column: string, value: string): void {
    this.push(`${column} = ?`, { type: 'TEXT', value });
  }

  addIsNull(column: string): void {
    this.clauses.push(`${column} IS NULL`);
  }

  addIn(column: string, values: string[]): void {
    const placeholders = values.map(() => '?').join(', ');
    this.push(
      `${column} IN (${placeholders})`,
      ...values.map(v => ({ type: 'TEXT' as const, value: v }))
    );
  }

  addNotIn(column: string, values: string[]): void {
    const placeholders = values.map(() => '?').join(', ');
    this.push(
      `${column} NOT IN (${placeholders})`,
      ...values.map(v => ({ type: 'TEXT' as const, value: v }))
    );
  }

  sql(): string {
    return this.clauses.length > 0 ? this.clauses.join('\n  AND ') : '1=1';
  }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

async function ensureScopeAccess(ctx: TRPCContext, filters: UsageAnalyticsFilters): Promise<void> {
  const userId = ctx.user.id;
  if (filters.organizationId) {
    const requiredRoles =
      filters.viewAs === 'org-wide' ? (['owner', 'billing_manager'] as const) : undefined;
    await ensureOrganizationAccess(
      ctx,
      filters.organizationId,
      requiredRoles ? [...requiredRoles] : undefined
    );

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

function buildDateConditions(
  where: WhereBuilder,
  tier: GranularityTier,
  filters: UsageAnalyticsFilters
): void {
  const timeCol = getTimeColumn(tier);

  if (tier === 'hourly') {
    where.addTimestampRange(timeCol, filters.startDate, filters.endDate);
  } else if (tier === 'daily') {
    where.addDateRange(
      timeCol,
      filters.startDate.slice(0, 10),
      ceilIsoToUtcDayExclusive(filters.endDate)
    );
  } else {
    // monthly — daily table, filter by day boundaries aligned to month
    where.addDateRange(
      timeCol,
      floorIsoToUtcMonth(filters.startDate),
      ceilIsoToUtcMonthExclusive(filters.endDate)
    );
  }
}

function buildScopeConditions(
  where: WhereBuilder,
  filters: UsageAnalyticsFilters,
  ctxUserId: string
): void {
  if (filters.organizationId) {
    where.addEq('organization_id', filters.organizationId);
    if (filters.viewAs === 'self') {
      where.addEq('kilo_user_id', ctxUserId);
    } else {
      if (filters.userIds && filters.userIds.length > 0) {
        where.addIn('kilo_user_id', filters.userIds);
      }
      if (filters.excludedUserIds && filters.excludedUserIds.length > 0) {
        where.addNotIn('kilo_user_id', filters.excludedUserIds);
      }
    }
  } else {
    where.addEq('kilo_user_id', ctxUserId);
    if (filters.personalScope === 'personal-only') {
      // DBT coalesces personal Snowflake usage rollups to an empty-string sentinel
      // so incremental merges can match on organization_id.
      where.addEq('organization_id', '');
    }
  }
}

function buildDimensionConditions(where: WhereBuilder, filters: UsageAnalyticsFilters): void {
  const addInIfNonEmpty = (column: string, values: string[] | undefined) => {
    if (values && values.length > 0) where.addIn(column, values);
  };
  const addNotInIfNonEmpty = (column: string, values: string[] | undefined) => {
    if (values && values.length > 0) where.addNotIn(column, values);
  };

  addInIfNonEmpty('feature', filters.features);
  addInIfNonEmpty('model', filters.models);
  addInIfNonEmpty('mode', filters.modes);
  addInIfNonEmpty('provider', filters.providers);
  addInIfNonEmpty('project_id', filters.projects);
  addNotInIfNonEmpty('feature', filters.excludedFeatures);
  addNotInIfNonEmpty('model', filters.excludedModels);
  addNotInIfNonEmpty('mode', filters.excludedModes);
  addNotInIfNonEmpty('provider', filters.excludedProviders);
  addNotInIfNonEmpty('project_id', filters.excludedProjects);
}

function buildWhereClause(
  tier: GranularityTier,
  filters: UsageAnalyticsFilters,
  ctxUserId: string,
  includeDimensions: boolean
): WhereBuilder {
  const where = new WhereBuilder();
  buildDateConditions(where, tier, filters);
  buildScopeConditions(where, filters, ctxUserId);
  if (includeDimensions) {
    buildDimensionConditions(where, filters);
  }
  return where;
}

// ---------------------------------------------------------------------------
// Metric SQL expression
// ---------------------------------------------------------------------------

function metricExprSql(metric: Metric): string {
  switch (metric) {
    case 'cost':
      return 'COALESCE(SUM(total_cost_microdollars), 0)';
    case 'requests':
      return 'COALESCE(SUM(request_count), 0)';
    case 'inputTokens':
      return 'COALESCE(SUM(total_input_tokens), 0)';
    case 'outputTokens':
      return 'COALESCE(SUM(total_output_tokens), 0)';
    case 'tokens':
      return 'COALESCE(SUM(total_input_tokens + total_output_tokens), 0)';
    case 'errorRate':
      return 'CASE WHEN COALESCE(SUM(request_count), 0) = 0 THEN 0 ELSE COALESCE(SUM(error_count), 0)::FLOAT / SUM(request_count)::FLOAT END';
    case 'avgLatencyMs':
      return 'CASE WHEN COALESCE(SUM(latency_count), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_latency_ms), 0)::FLOAT / SUM(latency_count)::FLOAT END';
    case 'avgGenerationTimeMs':
      return 'CASE WHEN COALESCE(SUM(latency_count), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_generation_time_ms), 0)::FLOAT / SUM(latency_count)::FLOAT END';
    case 'costPerRequest':
      return 'CASE WHEN COALESCE(SUM(request_count), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_cost_microdollars), 0)::FLOAT / SUM(request_count)::FLOAT END';
    case 'tokensPerRequest':
      return 'CASE WHEN COALESCE(SUM(request_count), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_input_tokens + total_output_tokens), 0)::FLOAT / SUM(request_count)::FLOAT END';
    case 'cacheHitRatio':
      return 'CASE WHEN COALESCE(SUM(total_input_tokens + total_cache_hit_tokens), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_cache_hit_tokens), 0)::FLOAT / SUM(total_input_tokens + total_cache_hit_tokens)::FLOAT END';
    case 'outputInputRatio':
      return 'CASE WHEN COALESCE(SUM(total_input_tokens), 0) = 0 THEN 0 ELSE COALESCE(SUM(total_output_tokens), 0)::FLOAT / SUM(total_input_tokens)::FLOAT END';
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
 * Month   → 'YYYY-MM-DD' of the first of the month (from daily table)
 */
function bucketExprSql(effectiveGranularity: Granularity, tier: GranularityTier): string {
  const timeCol = getTimeColumn(tier);

  if (effectiveGranularity === 'hour') {
    return `TO_VARCHAR(${timeCol}, 'YYYY-MM-DD HH24:MI:SS')`;
  }
  if (effectiveGranularity === 'week') {
    return `TO_VARCHAR(DATE_TRUNC('WEEK', ${timeCol}), 'YYYY-MM-DD')`;
  }
  if (effectiveGranularity === 'month') {
    // Daily table, group by month
    return `TO_VARCHAR(DATE_TRUNC('MONTH', ${timeCol}), 'YYYY-MM-DD')`;
  }
  // 'day'
  return `TO_VARCHAR(${timeCol}, 'YYYY-MM-DD')`;
}

// ---------------------------------------------------------------------------
// Dimension column name
// ---------------------------------------------------------------------------

function dimensionColumn(dimension: Dimension): string {
  switch (dimension) {
    case 'feature':
      return 'feature';
    case 'model':
      return 'model';
    case 'mode':
      return 'mode';
    case 'user':
      return 'kilo_user_id';
    case 'provider':
      return 'provider';
    case 'project':
      return 'project_id';
  }
}

// ---------------------------------------------------------------------------
// Timed query wrapper
// ---------------------------------------------------------------------------

function parseTimeoutEnv(envKey: string, fallback: number): number {
  const raw = getEnvVariable(envKey);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function defaultTimeoutForScope(scope: 'user' | 'org' | 'admin'): number {
  if (scope === 'admin') return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_ADMIN_MS', 20_000);
  if (scope === 'org') return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_ORG_MS', 10_000);
  return parseTimeoutEnv('USAGE_QUERY_TIMEOUT_USER_MS', 5_000);
}

async function timedSnowflakeQuery<T>(
  params: {
    route: string;
    queryLabel: string;
    scope: 'user' | 'org' | 'admin';
    period: string | null;
    timeoutMs?: number;
  },
  queryFn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = params.timeoutMs ?? defaultTimeoutForScope(params.scope);
  const start = performance.now();
  let rowCount = 0;

  const controller = new AbortController();
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) controller.abort();
  }, timeoutMs);

  try {
    const result = await queryFn(controller.signal);
    settled = true;
    rowCount = Array.isArray(result) ? result.length : 1;
    return result;
  } catch (error) {
    settled = true;
    console.error(
      JSON.stringify({
        type: 'usage_query_error',
        route: params.route,
        queryLabel: params.queryLabel,
        scope: params.scope,
        period: params.period,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Usage data temporarily unavailable',
    });
  } finally {
    clearTimeout(timer);
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    console.log(
      JSON.stringify({
        type: 'usage_query',
        route: params.route,
        queryLabel: params.queryLabel,
        scope: params.scope,
        period: params.period,
        durationMs,
        rowCount,
        timeoutMs,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

const SummaryOutputSchema = z.object({
  costMicrodollars: z.number(),
  requestCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheHitTokens: z.number(),
  errorCount: z.number(),
  cancelledCount: z.number(),
  freeRequestCount: z.number(),
  byokRequestCount: z.number(),
  totalLatencyMs: z.number(),
  totalGenerationTimeMs: z.number(),
  latencyCount: z.number(),
  distinctUsers: z.number(),
  errorRate: z.number(),
  avgLatencyMs: z.number(),
  avgGenerationTimeMs: z.number(),
  costPerRequest: z.number(),
  tokensPerRequest: z.number(),
  cacheHitRatio: z.number(),
  outputInputRatio: z.number(),
  effectiveGranularity: GranularitySchema,
});

type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

function ratioSafe(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Convert an aggregate value (often returned as a string by Snowflake) to a
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
// Timeseries
// ---------------------------------------------------------------------------

const TimeseriesInputSchema = UsageAnalyticsFiltersSchema.extend({
  metric: MetricSchema,
  splitBy: DimensionSchema.optional(),
});

const TimeseriesPointSchema = z.object({
  datetime: z.string(),
  value: z.number(),
  label: z.string().optional(),
});

const TimeseriesOutputSchema = z.object({
  timeseries: z.array(TimeseriesPointSchema),
  effectiveGranularity: GranularitySchema,
});

// ---------------------------------------------------------------------------
// Breakdown
// ---------------------------------------------------------------------------

const BreakdownInputSchema = UsageAnalyticsFiltersSchema.extend({
  dimension: DimensionSchema,
  metric: z.enum(['cost', 'requests', 'tokens']),
  limit: z.number().int().min(1).max(100).default(15),
});

const BreakdownItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  percentage: z.number(),
});

const BreakdownOutputSchema = z.object({
  breakdown: z.array(BreakdownItemSchema),
  totalValue: z.number(),
  effectiveGranularity: GranularitySchema,
});

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const TableInputSchema = UsageAnalyticsFiltersSchema.extend({
  groupBy: z.array(DimensionSchema).max(3),
  limit: z.number().int().min(1).max(10_000).default(1000),
});

const TableRowSchema = z.object({
  datetime: z.string(),
  dimensions: z.record(z.string(), z.string()),
  costMicrodollars: z.number(),
  requestCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheHitTokens: z.number(),
  errorCount: z.number(),
});

const TableOutputSchema = z.object({
  rows: z.array(TableRowSchema),
  effectiveGranularity: GranularitySchema,
});

// ---------------------------------------------------------------------------
// User list (for org context)
// ---------------------------------------------------------------------------

const UserListInputSchema = z.object({
  organizationId: z.uuid(),
  userIds: z.array(z.string()).max(200),
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
// Router definition
// ---------------------------------------------------------------------------

export const usageAnalyticsRouter = createTRPCRouter({
  getSummary: baseProcedure
    .input(UsageAnalyticsFiltersSchema)
    .output(SummaryOutputSchema)
    .query(async ({ input, ctx }): Promise<SummaryOutput> => {
      await ensureScopeAccess(ctx, input);

      const config = resolveSnowflakeConfig();
      const meta = resolveTier(input.granularity, input.startDate);
      if (!config) {
        return {
          costMicrodollars: 0,
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheHitTokens: 0,
          errorCount: 0,
          cancelledCount: 0,
          freeRequestCount: 0,
          byokRequestCount: 0,
          totalLatencyMs: 0,
          totalGenerationTimeMs: 0,
          latencyCount: 0,
          distinctUsers: 0,
          errorRate: 0,
          avgLatencyMs: 0,
          avgGenerationTimeMs: 0,
          costPerRequest: 0,
          tokensPerRequest: 0,
          cacheHitRatio: 0,
          outputInputRatio: 0,
          effectiveGranularity: meta.effectiveGranularity,
        };
      }
      const table = getTableName(meta.tier);
      const where = buildWhereClause(meta.tier, input, ctx.user.id, true);

      const statement = `
        SELECT
          COALESCE(SUM(total_cost_microdollars), 0),
          COALESCE(SUM(request_count), 0),
          COALESCE(SUM(total_input_tokens), 0),
          COALESCE(SUM(total_output_tokens), 0),
          COALESCE(SUM(total_cache_write_tokens), 0),
          COALESCE(SUM(total_cache_hit_tokens), 0),
          COALESCE(SUM(error_count), 0),
          COALESCE(SUM(cancelled_count), 0),
          COALESCE(SUM(free_request_count), 0),
          COALESCE(SUM(byok_request_count), 0),
          COALESCE(SUM(total_latency_ms), 0),
          COALESCE(SUM(total_generation_time_ms), 0),
          COALESCE(SUM(latency_count), 0),
          COUNT(DISTINCT kilo_user_id)
        FROM ${table}
        WHERE ${where.sql()}
      `;

      const rows = await timedSnowflakeQuery(
        {
          route: 'usageAnalytics.getSummary',
          queryLabel: `summary_${meta.tier}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        signal =>
          executeSnowflakeStatement({
            config,
            statement,
            bindings: where.bindings,
            timeoutSeconds: Math.ceil(
              defaultTimeoutForScope(input.organizationId ? 'org' : 'user') / 1000
            ),
            signal,
          })
      );

      const row = rows[0] ?? [];

      const costMicrodollars = toSafeNumber(row[0]);
      const requestCount = toSafeNumber(row[1]);
      const inputTokens = toSafeNumber(row[2]);
      const outputTokens = toSafeNumber(row[3]);
      const cacheWriteTokens = toSafeNumber(row[4]);
      const cacheHitTokens = toSafeNumber(row[5]);
      const errorCount = toSafeNumber(row[6]);
      const cancelledCount = toSafeNumber(row[7]);
      const freeRequestCount = toSafeNumber(row[8]);
      const byokRequestCount = toSafeNumber(row[9]);
      const totalLatencyMs = toSafeNumber(row[10]);
      const totalGenerationTimeMs = toSafeNumber(row[11]);
      const latencyCount = toSafeNumber(row[12]);
      const distinctUsers = toSafeNumber(row[13]);

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
        distinctUsers,
        errorRate: ratioSafe(errorCount, requestCount),
        avgLatencyMs: ratioSafe(totalLatencyMs, latencyCount),
        avgGenerationTimeMs: ratioSafe(totalGenerationTimeMs, latencyCount),
        costPerRequest: ratioSafe(costMicrodollars, requestCount),
        tokensPerRequest: ratioSafe(inputTokens + outputTokens, requestCount),
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

      const config = resolveSnowflakeConfig();
      const meta = resolveTier(input.granularity, input.startDate);
      if (!config) {
        return { timeseries: [], effectiveGranularity: meta.effectiveGranularity };
      }
      const table = getTableName(meta.tier);
      const bucketExpr = bucketExprSql(meta.effectiveGranularity, meta.tier);
      const metricExpr = metricExprSql(input.metric);
      const where = buildWhereClause(meta.tier, input, ctx.user.id, true);

      let statement: string;
      if (input.splitBy) {
        const splitCol = dimensionColumn(input.splitBy);
        statement = `
          SELECT
            ${bucketExpr} AS bucket,
            ${metricExpr} AS value,
            ${splitCol} AS label
          FROM ${table}
          WHERE ${where.sql()}
          GROUP BY 1, 3
          ORDER BY 1
        `;
      } else {
        statement = `
          SELECT
            ${bucketExpr} AS bucket,
            ${metricExpr} AS value
          FROM ${table}
          WHERE ${where.sql()}
          GROUP BY 1
          ORDER BY 1
        `;
      }

      const rows = await timedSnowflakeQuery(
        {
          route: 'usageAnalytics.getTimeseries',
          queryLabel: `timeseries_${meta.tier}${input.splitBy ? `_split_${input.splitBy}` : ''}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        signal =>
          executeSnowflakeStatement({
            config,
            statement,
            bindings: where.bindings,
            timeoutSeconds: Math.ceil(
              defaultTimeoutForScope(input.organizationId ? 'org' : 'user') / 1000
            ),
            signal,
          })
      );

      return {
        timeseries: rows.map(row => ({
          datetime: row[0] ?? '',
          value: toSafeNumber(row[1]),
          label: input.splitBy ? (row[2] ?? undefined) : undefined,
        })),
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  getBreakdown: baseProcedure
    .input(BreakdownInputSchema)
    .output(BreakdownOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureScopeAccess(ctx, input);

      const config = resolveSnowflakeConfig();
      const meta = resolveTier(input.granularity, input.startDate);
      if (!config) {
        return { breakdown: [], totalValue: 0, effectiveGranularity: meta.effectiveGranularity };
      }
      const table = getTableName(meta.tier);
      const dimCol = dimensionColumn(input.dimension);
      const metricExpr = metricExprSql(input.metric);
      const where = buildWhereClause(meta.tier, input, ctx.user.id, true);

      const statement = `
        SELECT
          ${dimCol} AS key,
          ${metricExpr} AS value
        FROM ${table}
        WHERE ${where.sql()}
        GROUP BY 1
        ORDER BY 2 DESC
        LIMIT ${Number(input.limit)}
      `;

      // SAFETY: LIMIT value is interpolated directly into SQL but is
      // validated by Zod above: `z.number().int().min(1).max(10_000)`.
      // Snowflake's SQL API v2 does not support parameter binding for LIMIT.

      const rows = await timedSnowflakeQuery(
        {
          route: 'usageAnalytics.getBreakdown',
          queryLabel: `breakdown_${meta.tier}_by_${input.dimension}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        signal =>
          executeSnowflakeStatement({
            config,
            statement,
            bindings: where.bindings,
            timeoutSeconds: Math.ceil(
              defaultTimeoutForScope(input.organizationId ? 'org' : 'user') / 1000
            ),
            signal,
          })
      );

      const values = rows.map(row => ({ key: row[0] ?? '', value: toSafeNumber(row[1]) }));
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

      const config = resolveSnowflakeConfig();
      const meta = resolveTier(input.granularity, input.startDate);
      if (!config) {
        return { rows: [], effectiveGranularity: meta.effectiveGranularity };
      }
      const table = getTableName(meta.tier);
      const bucketExpr = bucketExprSql(meta.effectiveGranularity, meta.tier);
      const where = buildWhereClause(meta.tier, input, ctx.user.id, true);

      const requestedDims = input.groupBy;

      // For dimensions not in groupBy, emit an empty string constant so the
      // row shape stays stable regardless of which dimensions were requested.
      const featExpr = requestedDims.includes('feature') ? 'feature' : "''";
      const modelExpr = requestedDims.includes('model') ? 'model' : "''";
      const modeExpr = requestedDims.includes('mode') ? 'mode' : "''";
      const userExpr = requestedDims.includes('user') ? 'kilo_user_id' : "''";
      const providerExpr = requestedDims.includes('provider') ? 'provider' : "''";
      const projectExpr = requestedDims.includes('project') ? 'project_id' : "''";

      // GROUP BY columns: bucket (pos 1) + each requested dimension column
      // SAFETY: dimensionColumn() returns only hardcoded string literals from
      // a typed enum chain — never user input.
      const dimGroupByCols = requestedDims.map(d => dimensionColumn(d)).join(', ');
      const groupByClause = dimGroupByCols ? `1, ${dimGroupByCols}` : '1';

      const statement = `
        SELECT
          ${bucketExpr} AS datetime,
          ${featExpr} AS dim_feature,
          ${modelExpr} AS dim_model,
          ${modeExpr} AS dim_mode,
          ${userExpr} AS dim_user,
          ${providerExpr} AS dim_provider,
          ${projectExpr} AS dim_project,
          COALESCE(SUM(total_cost_microdollars), 0),
          COALESCE(SUM(request_count), 0),
          COALESCE(SUM(total_input_tokens), 0),
          COALESCE(SUM(total_output_tokens), 0),
          COALESCE(SUM(total_cache_write_tokens), 0),
          COALESCE(SUM(total_cache_hit_tokens), 0),
          COALESCE(SUM(error_count), 0)
        FROM ${table}
        WHERE ${where.sql()}
        GROUP BY ${groupByClause}
        ORDER BY 1 DESC
        LIMIT ${Number(input.limit)}
      `;

      const rows = await timedSnowflakeQuery(
        {
          route: 'usageAnalytics.getTable',
          queryLabel: `table_${meta.tier}_groupby_${requestedDims.join('+') || 'none'}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        signal =>
          executeSnowflakeStatement({
            config,
            statement,
            bindings: where.bindings,
            timeoutSeconds: Math.ceil(
              defaultTimeoutForScope(input.organizationId ? 'org' : 'user') / 1000
            ),
            signal,
          })
      );

      const dimIndexMap: Record<Dimension, number> = {
        feature: 1,
        model: 2,
        mode: 3,
        user: 4,
        provider: 5,
        project: 6,
      };

      return {
        rows: rows.map(row => {
          const dimensions: Record<string, string> = {};
          for (const d of requestedDims) {
            const raw = row[dimIndexMap[d]];
            dimensions[d] = typeof raw === 'string' ? raw : '';
          }
          return {
            datetime: row[0] ?? '',
            dimensions,
            costMicrodollars: toSafeNumber(row[7]),
            requestCount: toSafeNumber(row[8]),
            inputTokens: toSafeNumber(row[9]),
            outputTokens: toSafeNumber(row[10]),
            cacheWriteTokens: toSafeNumber(row[11]),
            cacheHitTokens: toSafeNumber(row[12]),
            errorCount: toSafeNumber(row[13]),
          };
        }),
        effectiveGranularity: meta.effectiveGranularity,
      };
    }),

  /**
   * Look up user names and emails for a set of user IDs that belong to an org.
   * Used by the UI to decorate per-user breakdowns.
   *
   * Only returns users that are active or invited members of `organizationId`
   * to prevent callers from enumerating arbitrary kilocode_users PII.
   *
   * Members (role != 'owner' | 'billing_manager') can only resolve their own
   * id — they have no legitimate need to see other members' name/email from
   * this endpoint.
   */
  resolveOrgUsers: baseProcedure
    .input(UserListInputSchema)
    .output(UserListOutputSchema)
    .query(async ({ input, ctx }) => {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);

      const canSeeAllMembers = role === 'owner' || role === 'billing_manager';
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
            eq(organization_memberships.organization_id, input.organizationId)
          )
        )
        .where(inArray(kilocode_users.id, allowedIds));

      return {
        users: rows.map(r => ({
          id: r.id,
          name: r.name,
          email: r.email,
        })),
      };
    }),
});
