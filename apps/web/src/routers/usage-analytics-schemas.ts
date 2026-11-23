import * as z from 'zod';

/**
 * Upper bound on the orgs in an "All Organizations" aggregate (a parent plus
 * its children). Bounds this caller-controlled input so it cannot generate an
 * unbounded SQL `IN` clause, while staying well above any realistic two-level
 * org hierarchy so legitimate parents are never rejected. (Authorization is
 * batched into a fixed number of queries, so the cap need not be tight.)
 */
export const MAX_SCOPE_ORGANIZATION_IDS = 1_000;

/**
 * Upper bound on the values accepted in one dimension filter list (`features`,
 * `models`, `autoModels`, `modes`, `userIds`, `providers`,
 * `inferenceProviders`, `projects`, and each `excluded*` twin). The dashboard
 * filter picker offers at most 100 suggestions per dimension, so this leaves
 * ample room for any real selection.
 */
export const MAX_FILTER_VALUES = 500;

/**
 * Upper bound on the length of one dimension filter value. Filter values are
 * feature, model, mode, provider and project identifiers plus user UUIDs; this
 * is well above any real identifier.
 */
export const MAX_FILTER_VALUE_LENGTH = 256;

/**
 * Pools the benchmark charges view renders at once. A caller's own benchmark
 * spend comes from pools they confirmed, so this is far above any realistic
 * count while keeping the grouped Snowflake result bounded.
 */
export const MAX_BENCHMARK_POOLS = 100;

/** Concrete models listed per pool before the rest are folded into one row. */
export const MAX_BENCHMARK_MODELS_PER_POOL = 20;

export const GranularitySchema = z.enum(['hour', 'day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const CostSourceSchema = z.enum(['cost', 'market']);
export type CostSource = z.infer<typeof CostSourceSchema>;

export const DimensionSchema = z.enum([
  'feature',
  'model',
  'mode',
  'user',
  'provider',
  'project',
  'autoModel',
  'inferenceProvider',
]);
export type Dimension = z.infer<typeof DimensionSchema>;

export const BreakdownDimensionSchema = z.enum([...DimensionSchema.options, 'organization']);
export type BreakdownDimension = z.infer<typeof BreakdownDimensionSchema>;

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

/** One dimension filter list, bounded by the shared count and length limits. */
const FilterValuesSchema = z
  .array(z.string().max(MAX_FILTER_VALUE_LENGTH))
  .max(MAX_FILTER_VALUES)
  .optional();

const FiltersShape = {
  startDate: z.iso.datetime(),
  endDate: z.iso.datetime(),
  granularity: GranularitySchema,
  costSource: CostSourceSchema.default('cost'),
  organizationId: z.uuid().optional(),
  /**
   * Aggregate usage across multiple organizations (a parent org plus its
   * children). When set and non-empty, this takes precedence over
   * `organizationId` and is always treated as an org-wide view. The caller must
   * have owner/billing_manager access to every listed org.
   */
  organizationIds: z.array(z.uuid()).max(MAX_SCOPE_ORGANIZATION_IDS).optional(),
  personalScope: z.enum(['personal-only', 'include-orgs']).default('personal-only'),
  viewAs: z.enum(['self', 'org-wide']).default('self'),
  features: FilterValuesSchema,
  models: FilterValuesSchema,
  autoModels: FilterValuesSchema,
  modes: FilterValuesSchema,
  userIds: FilterValuesSchema,
  providers: FilterValuesSchema,
  inferenceProviders: FilterValuesSchema,
  projects: FilterValuesSchema,
  /**
   * Restrict the query to auto-routing benchmark charges (the reserved
   * `Auto-routing benchmarks / …` project namespace) instead of excluding them.
   * Ownership is still enforced from the usage rows' own user/organization
   * columns, so this selects a billing category, it does not widen scope.
   */
  benchmarkProjects: z.boolean().optional(),
  excludedFeatures: FilterValuesSchema,
  excludedModels: FilterValuesSchema,
  excludedAutoModels: FilterValuesSchema,
  excludedModes: FilterValuesSchema,
  excludedUserIds: FilterValuesSchema,
  excludedProviders: FilterValuesSchema,
  excludedInferenceProviders: FilterValuesSchema,
  excludedProjects: FilterValuesSchema,
} as const;

/** Half-open window refinement shared by every filters-derived input. */
const refineUsageWindow = <T extends z.ZodType<{ startDate: string; endDate: string }>>(
  schema: T
) =>
  schema.refine(input => new Date(input.startDate).getTime() <= new Date(input.endDate).getTime(), {
    message: 'Start date must not be after end date',
    path: ['endDate'],
  });

/**
 * The unrefined filter object. A procedure that must derive a narrower input
 * (the benchmark charges view) extends this shape; `.omit()` and `.extend()`
 * cannot run on a refined schema, so the shared shape and the window refinement
 * stay separate instead of being derived from each other.
 */
export const UsageAnalyticsFiltersObjectSchema = z.object(FiltersShape);

/**
 * The window is half-open: `startDate` is inclusive and `endDate` is exclusive.
 * Equal boundaries stay valid; the query window may still span the containing
 * day or month bucket.
 */
export const UsageAnalyticsFiltersSchema = refineUsageWindow(UsageAnalyticsFiltersObjectSchema);
export type UsageAnalyticsFilters = z.infer<typeof UsageAnalyticsFiltersSchema>;

export const SummaryOutputSchema = z.object({
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
  generationTimeCount: z.number(),
  totalTokens: z.number(),
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
export type SummaryOutput = z.infer<typeof SummaryOutputSchema>;

export const TimeseriesInputSchema = UsageAnalyticsFiltersSchema.extend({
  metric: MetricSchema,
  splitBy: DimensionSchema.optional(),
});

const TimeseriesPointSchema = z.object({
  datetime: z.string(),
  value: z.number(),
  label: z.string().optional(),
});

export const TimeseriesOutputSchema = z.object({
  timeseries: z.array(TimeseriesPointSchema),
  effectiveGranularity: GranularitySchema,
});

export const BreakdownInputSchema = UsageAnalyticsFiltersSchema.extend({
  dimension: BreakdownDimensionSchema,
  metric: z.enum(['cost', 'requests', 'tokens']),
  limit: z.number().int().min(1).max(MAX_SCOPE_ORGANIZATION_IDS).default(15),
}).refine(input => input.dimension === 'organization' || input.limit <= 100, {
  message: 'Limit cannot exceed 100 for this breakdown dimension',
  path: ['limit'],
});

const BreakdownItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  percentage: z.number(),
});

export const BreakdownOutputSchema = z.object({
  breakdown: z.array(BreakdownItemSchema),
  totalValue: z.number(),
  effectiveGranularity: GranularitySchema,
});

export const TableInputSchema = UsageAnalyticsFiltersSchema.extend({
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

export const TableOutputSchema = z.object({
  rows: z.array(TableRowSchema),
  effectiveGranularity: GranularitySchema,
});

/**
 * The auto-routing benchmark charges view: the reserved benchmark project
 * namespace grouped into saved pools, each with its concrete-model split.
 *
 * Input is the ordinary analytics filter without `benchmarkProjects`, which the
 * procedure always applies itself so the view cannot accidentally widen to all
 * usage. Every other filter, including the project filters, still applies: with
 * a project filter that names a real workspace this view is correctly empty
 * rather than quietly ignoring the filter. `poolLimit` bounds the pool rows.
 *
 * Built from the unrefined filter object because `.omit()` rejects a schema
 * carrying refinements; the window refinement is re-applied here so this input
 * validates exactly like every other analytics request.
 */
export const BenchmarkChargesInputSchema = refineUsageWindow(
  UsageAnalyticsFiltersObjectSchema.omit({ benchmarkProjects: true }).extend({
    poolLimit: z.number().int().min(1).max(MAX_BENCHMARK_POOLS).default(MAX_BENCHMARK_POOLS),
  })
);

const BenchmarkModelChargeSchema = z.object({
  /** Concrete dispatched model, as recorded on the usage row. */
  model: z.string(),
  costMicrodollars: z.number(),
  requestCount: z.number(),
});

export const BenchmarkPoolChargeSchema = z.object({
  /** Full reserved-namespace project id: the stable key, unique per pool. */
  projectId: z.string(),
  /** Saved pool slug. */
  poolSlug: z.string(),
  /** Immutable saved-pool UUID, distinguishing a recreated slug. */
  routerId: z.string(),
  poolScope: z.enum(['user', 'org']),
  costMicrodollars: z.number(),
  requestCount: z.number(),
  /** Top concrete models by cost, at most `MAX_BENCHMARK_MODELS_PER_POOL`. */
  models: z.array(BenchmarkModelChargeSchema),
  /**
   * Charges for the pool's remaining models, folded so a wide pool stays
   * bounded. Derived by subtracting the listed models from the pool total, so
   * the pool row and its models always reconcile exactly.
   */
  otherModelsCostMicrodollars: z.number(),
  otherModelsRequestCount: z.number(),
});
export type BenchmarkPoolCharge = z.infer<typeof BenchmarkPoolChargeSchema>;

export const BenchmarkChargesOutputSchema = z.object({
  /** `empty` means the caller has no benchmark charges in this window. */
  status: z.enum(['ok', 'empty']),
  totalCostMicrodollars: z.number(),
  totalRequestCount: z.number(),
  pools: z.array(BenchmarkPoolChargeSchema),
  /** More pools have charges than `poolLimit` showed, so the list is partial. */
  hasMorePools: z.boolean(),
});
export type BenchmarkChargesOutput = z.infer<typeof BenchmarkChargesOutputSchema>;
