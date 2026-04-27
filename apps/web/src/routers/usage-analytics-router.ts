import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { and, desc, eq, gte, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { readDb } from '@/lib/drizzle';
import { timedUsageQuery } from '@/lib/usage-query';
import {
  usage_rollup_hourly,
  usage_rollup_daily,
  usage_rollup_monthly,
  usage_rollup_hourly_totals,
  usage_rollup_daily_totals,
  usage_rollup_monthly_totals,
  kilocode_users,
  organization_memberships,
} from '@kilocode/db/schema';
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
// Table resolution
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
    if (ageDays <= 7) {
      return { tier: 'hourly', effectiveGranularity: 'hour' };
    }
    // Auto-downgrade: hourly retention is 7 days
    return { tier: 'daily', effectiveGranularity: 'day' };
  }

  if (granularity === 'day' || granularity === 'week') {
    if (ageDays <= 90) {
      return { tier: 'daily', effectiveGranularity: granularity };
    }
    return { tier: 'monthly', effectiveGranularity: 'month' };
  }

  return { tier: 'monthly', effectiveGranularity: 'month' };
}

/**
 * Returns true iff the query requires the wide rollup table (because it filters
 * on a dimension that only exists in the wide table). User-scope filters
 * (userIds / excludedUserIds) and organization filter work on both wide and
 * totals tables, so they don't force the wide table.
 */
function hasDimensionFilters(filters: UsageAnalyticsFilters): boolean {
  const nonEmpty = (a?: string[]) => !!a && a.length > 0;
  return (
    nonEmpty(filters.features) ||
    nonEmpty(filters.models) ||
    nonEmpty(filters.modes) ||
    nonEmpty(filters.providers) ||
    nonEmpty(filters.projects) ||
    nonEmpty(filters.excludedFeatures) ||
    nonEmpty(filters.excludedModels) ||
    nonEmpty(filters.excludedModes) ||
    nonEmpty(filters.excludedProviders) ||
    nonEmpty(filters.excludedProjects)
  );
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

    // In 'self' mode, explicit user filters must refer only to the caller.
    // Prevents a member from crafting `userIds: [someoneElse]` in self scope.
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

  // Personal scope: user filters must refer only to the authenticated user.
  const allUserFilterValues = [...(filters.userIds ?? []), ...(filters.excludedUserIds ?? [])];
  if (allUserFilterValues.some(v => v !== userId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Personal analytics can only filter to own user.',
    });
  }
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

type WideTable =
  | typeof usage_rollup_hourly
  | typeof usage_rollup_daily
  | typeof usage_rollup_monthly;

type TotalsTable =
  | typeof usage_rollup_hourly_totals
  | typeof usage_rollup_daily_totals
  | typeof usage_rollup_monthly_totals;

function getWideTable(tier: GranularityTier): WideTable {
  switch (tier) {
    case 'hourly':
      return usage_rollup_hourly;
    case 'daily':
      return usage_rollup_daily;
    case 'monthly':
      return usage_rollup_monthly;
  }
}

function getTotalsTable(tier: GranularityTier): TotalsTable {
  switch (tier) {
    case 'hourly':
      return usage_rollup_hourly_totals;
    case 'daily':
      return usage_rollup_daily_totals;
    case 'monthly':
      return usage_rollup_monthly_totals;
  }
}

/**
 * Returns the tier-specific time column. Drizzle's column type for `hour`
 * (timestamp) and `day`/`month` (date with mode:'string') both carry their
 * literal data type as `string`, so callers can compare against string values
 * without further narrowing.
 */
function getTimeColumn(tier: GranularityTier, table: WideTable | TotalsTable) {
  if (tier === 'hourly') {
    if (isHourlyTable(table)) return table.hour;
    throw new Error(`Expected hourly table for tier 'hourly'`);
  }
  if (tier === 'daily') {
    if (isDailyTable(table)) return table.day;
    throw new Error(`Expected daily table for tier 'daily'`);
  }
  if (isMonthlyTable(table)) return table.month;
  throw new Error(`Expected monthly table for tier 'monthly'`);
}

// Identity-based guards (vs. structural `'hour' in table`) so a future rename
// or new rollup table that happens to share a column name can't silently
// mis-narrow.
function isHourlyTable(
  table: WideTable | TotalsTable
): table is typeof usage_rollup_hourly | typeof usage_rollup_hourly_totals {
  return table === usage_rollup_hourly || table === usage_rollup_hourly_totals;
}

function isDailyTable(
  table: WideTable | TotalsTable
): table is typeof usage_rollup_daily | typeof usage_rollup_daily_totals {
  return table === usage_rollup_daily || table === usage_rollup_daily_totals;
}

function isMonthlyTable(
  table: WideTable | TotalsTable
): table is typeof usage_rollup_monthly | typeof usage_rollup_monthly_totals {
  return table === usage_rollup_monthly || table === usage_rollup_monthly_totals;
}

/**
 * Rollup buckets are aligned to UTC calendar day/month boundaries. When the
 * caller supplies an `endDate` with a time-of-day (e.g. `2026-04-10T15:32:00Z`
 * for "past 7d"), slicing to YYYY-MM-DD and using `lt` would silently drop
 * today's partially-complete daily/monthly row. This function returns the
 * exclusive calendar-day boundary that includes today when endDate has any
 * time-of-day, and matches the midnight-aligned boundary exactly when endDate
 * is already at UTC midnight (e.g. the "yesterday" preset).
 */
function ceilIsoToUtcDayExclusive(iso: string): string {
  const d = new Date(iso);
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (d.getTime() === dayStartMs) {
    return iso.slice(0, 10);
  }
  return new Date(dayStartMs + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Floor an ISO date/datetime to the first day of its UTC calendar month.
 * Used for the monthly tier's lower bound so that the month containing the
 * start of the window is included, even when startDate is not itself the
 * first of the month.
 */
function floorIsoToUtcMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * Ceil an ISO date/datetime to the first day of the next UTC calendar month,
 * used as an exclusive upper bound. Matches the month exactly when iso is
 * already at the first of the month at UTC midnight.
 */
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
// Time bucketing for charts
// ---------------------------------------------------------------------------

function bucketExprForEffectiveGranularity(
  granularity: Granularity,
  tier: GranularityTier,
  table: WideTable | TotalsTable
) {
  const timeCol = getTimeColumn(tier, table);
  if (granularity === 'hour') return sql<string>`${timeCol}::text`;
  // Cast through ::date before ::text so the serialized bucket is
  // `YYYY-MM-DD` (which `isDateOnlyString` detects on the client and formats
  // with `timeZone: 'UTC'`). Without the explicit date cast, `date_trunc`
  // returns a timestamp and the client would format the week start in the
  // viewer's local zone, shifting the day for negative-UTC viewers.
  if (granularity === 'week') return sql<string>`date_trunc('week', ${timeCol})::date::text`;
  // 'day' and 'month' both match the column directly
  return sql<string>`${timeCol}::text`;
}

// ---------------------------------------------------------------------------
// Shared filters
// ---------------------------------------------------------------------------

type AnyPgTable = WideTable | TotalsTable;

function buildWhereCommon(
  filters: UsageAnalyticsFilters,
  table: AnyPgTable,
  ctxUserId: string,
  tier: GranularityTier
) {
  const conditions = [];

  if (tier === 'monthly' && isMonthlyTable(table)) {
    // Floor startDate to its month (include months that contain startDate) and
    // ceil endDate to the first of the next month so partial months at both
    // ends are visible to the caller.
    conditions.push(gte(table.month, floorIsoToUtcMonth(filters.startDate)));
    conditions.push(lt(table.month, ceilIsoToUtcMonthExclusive(filters.endDate)));
  } else if (tier === 'daily' && isDailyTable(table)) {
    // startDate at the daily tier is always UTC-midnight aligned by the UI,
    // so date-only slicing is lossless. endDate is usually mid-day ("now"),
    // so ceil to the next UTC day to include today's partial rollup row.
    conditions.push(gte(table.day, filters.startDate.slice(0, 10)));
    conditions.push(lt(table.day, ceilIsoToUtcDayExclusive(filters.endDate)));
  } else if (tier === 'hourly' && isHourlyTable(table)) {
    conditions.push(gte(table.hour, filters.startDate));
    conditions.push(lt(table.hour, filters.endDate));
  } else {
    // Unreachable under correct (tier, table) pairing; kept as a defense-in-depth
    // check so a future bug in getWideTable/getTotalsTable fails loudly rather
    // than silently returning no rows.
    throw new Error(`Unexpected table/tier combination: tier=${tier}`);
  }

  // Scope filter: either org or personal user. All rollup tables share
  // structural `organization_id` / `kilo_user_id` columns.
  if (filters.organizationId) {
    conditions.push(eq(table.organization_id, filters.organizationId));
    // 'self' mode: unconditionally restrict to the caller. This is the server-side
    // enforcement that prevents a member from seeing other members' usage.
    if (filters.viewAs === 'self') {
      conditions.push(eq(table.kilo_user_id, ctxUserId));
    } else {
      if (filters.userIds && filters.userIds.length > 0) {
        conditions.push(inArray(table.kilo_user_id, filters.userIds));
      }
      if (filters.excludedUserIds && filters.excludedUserIds.length > 0) {
        conditions.push(notInArray(table.kilo_user_id, filters.excludedUserIds));
      }
    }
  } else {
    conditions.push(eq(table.kilo_user_id, ctxUserId));
    if (filters.personalScope === 'personal-only') {
      conditions.push(isNull(table.organization_id));
    }
    // excludedUserIds in personal scope is already restricted to ctxUserId by
    // ensureScopeAccess, so it would exclude the user's own data — no-op filter.
  }

  return conditions;
}

function buildWideFilters(filters: UsageAnalyticsFilters, table: WideTable) {
  const conditions = [];
  if (filters.features && filters.features.length > 0) {
    conditions.push(inArray(table.feature, filters.features));
  }
  if (filters.models && filters.models.length > 0) {
    conditions.push(inArray(table.model, filters.models));
  }
  if (filters.modes && filters.modes.length > 0) {
    conditions.push(inArray(table.mode, filters.modes));
  }
  if (filters.providers && filters.providers.length > 0) {
    conditions.push(inArray(table.provider, filters.providers));
  }
  if (filters.projects && filters.projects.length > 0) {
    conditions.push(inArray(table.project_id, filters.projects));
  }
  if (filters.excludedFeatures && filters.excludedFeatures.length > 0) {
    conditions.push(notInArray(table.feature, filters.excludedFeatures));
  }
  if (filters.excludedModels && filters.excludedModels.length > 0) {
    conditions.push(notInArray(table.model, filters.excludedModels));
  }
  if (filters.excludedModes && filters.excludedModes.length > 0) {
    conditions.push(notInArray(table.mode, filters.excludedModes));
  }
  if (filters.excludedProviders && filters.excludedProviders.length > 0) {
    conditions.push(notInArray(table.provider, filters.excludedProviders));
  }
  if (filters.excludedProjects && filters.excludedProjects.length > 0) {
    conditions.push(notInArray(table.project_id, filters.excludedProjects));
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Metric expression helpers
// ---------------------------------------------------------------------------

function costSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).cost_microdollars}), 0)::bigint`;
}
function requestSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).request_count}), 0)::bigint`;
}
function inputSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).input_tokens}), 0)::bigint`;
}
function outputSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).output_tokens}), 0)::bigint`;
}
function cacheWriteSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).cache_write_tokens}), 0)::bigint`;
}
function cacheHitSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).cache_hit_tokens}), 0)::bigint`;
}
function errorSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).error_count}), 0)::bigint`;
}
function cancelledSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).cancelled_count}), 0)::bigint`;
}
function freeSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).free_request_count}), 0)::bigint`;
}
function byokSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).byok_request_count}), 0)::bigint`;
}
function totalLatencySum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).total_latency_ms}), 0)::bigint`;
}
function totalGenerationSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).total_generation_time_ms}), 0)::bigint`;
}
function latencyCountSum(table: AnyPgTable) {
  return sql<number>`COALESCE(SUM(${(table as WideTable).latency_count}), 0)::bigint`;
}
function distinctUsersCount(table: AnyPgTable) {
  return sql<number>`COUNT(DISTINCT ${(table as WideTable).kilo_user_id})::bigint`;
}

// ---------------------------------------------------------------------------
// Dimension column resolver
// ---------------------------------------------------------------------------

function getDimensionColumn(table: WideTable, dimension: Dimension) {
  switch (dimension) {
    case 'feature':
      return table.feature;
    case 'model':
      return table.model;
    case 'mode':
      return table.mode;
    case 'user':
      return table.kilo_user_id;
    case 'provider':
      return table.provider;
    case 'project':
      return table.project_id;
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
 * Convert an aggregate value (often returned as a bigint string by pg) to a
 * JS number. Postgres `SUM(bigint)` returns `numeric`; pg delivers it as a
 * string. `Number(...)` of a string larger than 2^53 silently loses precision.
 *
 * We log and return 0 for non-finite inputs (`undefined`, `null`, malformed
 * strings) to match the prior `Number(x) || 0` behavior. Values above
 * `MAX_SAFE_INTEGER` are logged as a warning but still returned so the UI
 * does not crash — precision loss here would mean an organization aggregated
 * over 9e15 microdollars ($9B+) in the window, well beyond realistic scale.
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
  tableType: z.enum(['wide', 'totals']),
});

function metricExpression(metric: Metric, table: AnyPgTable) {
  switch (metric) {
    case 'cost':
      return costSum(table);
    case 'requests':
      return requestSum(table);
    case 'inputTokens':
      return inputSum(table);
    case 'outputTokens':
      return outputSum(table);
    case 'tokens':
      return sql<number>`COALESCE(SUM(${(table as WideTable).input_tokens} + ${(table as WideTable).output_tokens}), 0)::bigint`;
    case 'errorRate':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).request_count}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).error_count}), 0)::float / SUM(${(table as WideTable).request_count})::float) END`;
    case 'avgLatencyMs':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).latency_count}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).total_latency_ms}), 0)::float / SUM(${(table as WideTable).latency_count})::float) END`;
    case 'avgGenerationTimeMs':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).latency_count}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).total_generation_time_ms}), 0)::float / SUM(${(table as WideTable).latency_count})::float) END`;
    case 'costPerRequest':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).request_count}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).cost_microdollars}), 0)::float / SUM(${(table as WideTable).request_count})::float) END`;
    case 'tokensPerRequest':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).request_count}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).input_tokens} + ${(table as WideTable).output_tokens}), 0)::float / SUM(${(table as WideTable).request_count})::float) END`;
    case 'cacheHitRatio':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).input_tokens} + ${(table as WideTable).cache_hit_tokens}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).cache_hit_tokens}), 0)::float / SUM(${(table as WideTable).input_tokens} + ${(table as WideTable).cache_hit_tokens})::float) END`;
    case 'outputInputRatio':
      return sql<number>`CASE WHEN COALESCE(SUM(${(table as WideTable).input_tokens}), 0) = 0 THEN 0 ELSE (COALESCE(SUM(${(table as WideTable).output_tokens}), 0)::float / SUM(${(table as WideTable).input_tokens})::float) END`;
  }
}

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

      const meta = resolveTier(input.granularity, input.startDate);
      const useWide = hasDimensionFilters(input);
      const table = useWide ? getWideTable(meta.tier) : getTotalsTable(meta.tier);

      const conditions = buildWhereCommon(input, table, ctx.user.id, meta.tier);
      if (useWide) {
        conditions.push(...buildWideFilters(input, table as WideTable));
      }

      const rows = await timedUsageQuery(
        {
          db: readDb,
          route: 'usageAnalytics.getSummary',
          queryLabel: `summary_${meta.tier}_${useWide ? 'wide' : 'totals'}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        tx =>
          tx
            .select({
              costMicrodollars: costSum(table),
              requestCount: requestSum(table),
              inputTokens: inputSum(table),
              outputTokens: outputSum(table),
              cacheWriteTokens: cacheWriteSum(table),
              cacheHitTokens: cacheHitSum(table),
              errorCount: errorSum(table),
              cancelledCount: cancelledSum(table),
              freeRequestCount: freeSum(table),
              byokRequestCount: byokSum(table),
              totalLatencyMs: totalLatencySum(table),
              totalGenerationTimeMs: totalGenerationSum(table),
              latencyCount: latencyCountSum(table),
              distinctUsers: distinctUsersCount(table),
            })
            .from(table)
            .where(and(...conditions))
      );

      const r = rows[0] ?? {
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
      };

      const costMicrodollars = toSafeNumber(r.costMicrodollars);
      const requestCount = toSafeNumber(r.requestCount);
      const inputTokens = toSafeNumber(r.inputTokens);
      const outputTokens = toSafeNumber(r.outputTokens);
      const cacheWriteTokens = toSafeNumber(r.cacheWriteTokens);
      const cacheHitTokens = toSafeNumber(r.cacheHitTokens);
      const errorCount = toSafeNumber(r.errorCount);
      const cancelledCount = toSafeNumber(r.cancelledCount);
      const freeRequestCount = toSafeNumber(r.freeRequestCount);
      const byokRequestCount = toSafeNumber(r.byokRequestCount);
      const totalLatencyMs = toSafeNumber(r.totalLatencyMs);
      const totalGenerationTimeMs = toSafeNumber(r.totalGenerationTimeMs);
      const latencyCount = toSafeNumber(r.latencyCount);
      const distinctUsers = toSafeNumber(r.distinctUsers);

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

      const meta = resolveTier(input.granularity, input.startDate);
      const needsWide = !!input.splitBy || hasDimensionFilters(input);
      const table = needsWide ? getWideTable(meta.tier) : getTotalsTable(meta.tier);
      const bucketExpr = bucketExprForEffectiveGranularity(
        meta.effectiveGranularity,
        meta.tier,
        table
      );

      const conditions = buildWhereCommon(input, table, ctx.user.id, meta.tier);
      if (needsWide) {
        conditions.push(...buildWideFilters(input, table as WideTable));
      }

      type Row = { bucket: string; value: number; label: string | null };

      let rows: Row[];
      if (input.splitBy) {
        if (!needsWide) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'splitBy requires wide table',
          });
        }
        const wideTable = table as WideTable;
        const splitCol = getDimensionColumn(wideTable, input.splitBy);
        const valueExpr = metricExpression(input.metric, wideTable);
        rows = await timedUsageQuery(
          {
            db: readDb,
            route: 'usageAnalytics.getTimeseries',
            queryLabel: `timeseries_${meta.tier}_wide_split_${input.splitBy}`,
            scope: input.organizationId ? 'org' : 'user',
            period: `${input.startDate}/${input.endDate}`,
          },
          tx =>
            tx
              .select({
                bucket: bucketExpr,
                value: valueExpr,
                label: splitCol,
              })
              .from(wideTable)
              .where(and(...conditions))
              .groupBy(bucketExpr, splitCol)
              .orderBy(bucketExpr)
        );
      } else {
        const valueExpr = metricExpression(input.metric, table);
        rows = await timedUsageQuery(
          {
            db: readDb,
            route: 'usageAnalytics.getTimeseries',
            queryLabel: `timeseries_${meta.tier}_${needsWide ? 'wide' : 'totals'}`,
            scope: input.organizationId ? 'org' : 'user',
            period: `${input.startDate}/${input.endDate}`,
          },
          tx =>
            tx
              .select({
                bucket: bucketExpr,
                value: valueExpr,
                label: sql<string | null>`NULL::text`,
              })
              .from(table)
              .where(and(...conditions))
              .groupBy(bucketExpr)
              .orderBy(bucketExpr)
        );
      }

      return {
        timeseries: rows.map(r => ({
          datetime: r.bucket,
          value: toSafeNumber(r.value),
          label: r.label ?? undefined,
        })),
        effectiveGranularity: meta.effectiveGranularity,
        tableType: needsWide ? ('wide' as const) : ('totals' as const),
      };
    }),

  getBreakdown: baseProcedure
    .input(BreakdownInputSchema)
    .output(BreakdownOutputSchema)
    .query(async ({ input, ctx }) => {
      await ensureScopeAccess(ctx, input);

      const meta = resolveTier(input.granularity, input.startDate);
      const table = getWideTable(meta.tier);
      const conditions = buildWhereCommon(input, table, ctx.user.id, meta.tier);
      conditions.push(...buildWideFilters(input, table));

      const dimCol = getDimensionColumn(table, input.dimension);
      const valueExpr = metricExpression(input.metric, table);

      const rows = await timedUsageQuery(
        {
          db: readDb,
          route: 'usageAnalytics.getBreakdown',
          queryLabel: `breakdown_${meta.tier}_by_${input.dimension}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        tx =>
          tx
            .select({
              key: dimCol,
              value: valueExpr,
            })
            .from(table)
            .where(and(...conditions))
            .groupBy(dimCol)
            .orderBy(desc(valueExpr))
            .limit(input.limit)
      );

      const values = rows.map(r => ({ key: r.key ?? '', value: toSafeNumber(r.value) }));
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
      const table = getWideTable(meta.tier);
      const conditions = buildWhereCommon(input, table, ctx.user.id, meta.tier);
      conditions.push(...buildWideFilters(input, table));

      const bucketExpr = bucketExprForEffectiveGranularity(
        meta.effectiveGranularity,
        meta.tier,
        table
      );

      // Always select all 6 dimension columns; we return only the ones in
      // input.groupBy to the client. We GROUP BY only the requested dimensions
      // plus the time bucket.
      const dimAliases = {
        dim_feature: table.feature,
        dim_model: table.model,
        dim_mode: table.mode,
        dim_user: table.kilo_user_id,
        dim_provider: table.provider,
        dim_project: table.project_id,
      } as const;

      const requestedDims = input.groupBy;
      const groupByCols = [bucketExpr, ...requestedDims.map(d => getDimensionColumn(table, d))];

      // For dimensions not in input.groupBy, emit a constant empty string in
      // the SELECT projection so the row shape stays stable. Using a constant
      // scalar sidesteps "column must appear in GROUP BY" without widening
      // the result type to nullable. The client-side mapping below only reads
      // dimensions listed in `requestedDims`, so the constants are invisible
      // to callers.
      const feat = requestedDims.includes('feature') ? dimAliases.dim_feature : sql<string>`''`;
      const model = requestedDims.includes('model') ? dimAliases.dim_model : sql<string>`''`;
      const mode = requestedDims.includes('mode') ? dimAliases.dim_mode : sql<string>`''`;
      const user = requestedDims.includes('user') ? dimAliases.dim_user : sql<string>`''`;
      const provider = requestedDims.includes('provider')
        ? dimAliases.dim_provider
        : sql<string>`''`;
      const project = requestedDims.includes('project') ? dimAliases.dim_project : sql<string>`''`;

      const rows = await timedUsageQuery(
        {
          db: readDb,
          route: 'usageAnalytics.getTable',
          queryLabel: `table_${meta.tier}_groupby_${input.groupBy.join('+') || 'none'}`,
          scope: input.organizationId ? 'org' : 'user',
          period: `${input.startDate}/${input.endDate}`,
        },
        tx =>
          tx
            .select({
              datetime: bucketExpr,
              dim_feature: feat,
              dim_model: model,
              dim_mode: mode,
              dim_user: user,
              dim_provider: provider,
              dim_project: project,
              costMicrodollars: costSum(table),
              requestCount: requestSum(table),
              inputTokens: inputSum(table),
              outputTokens: outputSum(table),
              cacheWriteTokens: cacheWriteSum(table),
              cacheHitTokens: cacheHitSum(table),
              errorCount: errorSum(table),
            })
            .from(table)
            .where(and(...conditions))
            .groupBy(...groupByCols)
            .orderBy(desc(bucketExpr))
            .limit(input.limit)
      );

      const dimKeyMap: Record<Dimension, keyof (typeof rows)[number]> = {
        feature: 'dim_feature',
        model: 'dim_model',
        mode: 'dim_mode',
        user: 'dim_user',
        provider: 'dim_provider',
        project: 'dim_project',
      };

      return {
        rows: rows.map(r => {
          const dimensions: Record<string, string> = {};
          for (const d of requestedDims) {
            const raw = r[dimKeyMap[d]];
            dimensions[d] = typeof raw === 'string' ? raw : '';
          }
          return {
            datetime: r.datetime,
            dimensions,
            costMicrodollars: toSafeNumber(r.costMicrodollars),
            requestCount: toSafeNumber(r.requestCount),
            inputTokens: toSafeNumber(r.inputTokens),
            outputTokens: toSafeNumber(r.outputTokens),
            cacheWriteTokens: toSafeNumber(r.cacheWriteTokens),
            cacheHitTokens: toSafeNumber(r.cacheHitTokens),
            errorCount: toSafeNumber(r.errorCount),
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
