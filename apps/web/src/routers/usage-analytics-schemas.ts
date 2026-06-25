import * as z from 'zod';

/**
 * Upper bound on the orgs in an "All Organizations" aggregate (a parent plus
 * its children). Bounds this caller-controlled input so it cannot generate an
 * unbounded SQL `IN` clause, while staying well above any realistic two-level
 * org hierarchy so legitimate parents are never rejected. (Authorization is
 * batched into a fixed number of queries, so the cap need not be tight.)
 */
export const MAX_SCOPE_ORGANIZATION_IDS = 1_000;

export const GranularitySchema = z.enum(['hour', 'day', 'week', 'month']);
export type Granularity = z.infer<typeof GranularitySchema>;

export const CostSourceSchema = z.enum(['cost', 'market']);
export type CostSource = z.infer<typeof CostSourceSchema>;

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

export const UsageAnalyticsFiltersSchema = z.object(FiltersShape);
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
