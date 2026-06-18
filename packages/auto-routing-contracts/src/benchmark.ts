import * as z from 'zod';
import { RoutingTableSchema } from './routing-table';
import { ReasoningEffortSchema } from './reasoning';
import { TaxonomyRouteKeySchema } from './taxonomy';

export { ReasoningEffortSchema } from './reasoning';
export type { ReasoningEffort } from './reasoning';

export const BenchmarkKindSchema = z.enum(['classifier', 'decider']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

export const BenchmarkDeciderModelSchema = z.object({
  id: z.string().trim().min(1),
  // Passed to the kilo CLI as --variant during the benchmark and carried into
  // the routing table so serving uses the same effort the model was graded
  // with. Null for models without (or not using) configurable reasoning.
  reasoningEffort: ReasoningEffortSchema.nullable().default(null),
});
export type BenchmarkDeciderModel = z.infer<typeof BenchmarkDeciderModelSchema>;

export const AUTO_DECIDER_DEFAULT_MIN_COST_USD = 15;
export const AUTO_DECIDER_DEFAULT_MAX_COST_USD = 25;

export const AutoBenchmarkDeciderModelSchema = BenchmarkDeciderModelSchema.extend({
  avgAttemptCostUsd: z.number().nonnegative(),
});
export type AutoBenchmarkDeciderModel = z.infer<typeof AutoBenchmarkDeciderModelSchema>;

// Flags each list entry whose (trimmed) id already appeared earlier in the
// array. Model ids are the D1 primary keys for config_classifier_models /
// config_decider_models, so duplicates would otherwise reach the DB as an
// opaque constraint violation (HTTP 500) instead of an actionable 400.
function addDuplicateModelIssues(ids: string[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: [path, index],
        message: `Duplicate model id: ${id}`,
      });
    }
    seen.add(id);
  });
}

export const BenchmarkConfigSchema = z
  .object({
    classifierModels: z.array(z.string().trim().min(1)).min(1),
    deciderModels: z.array(BenchmarkDeciderModelSchema).min(1),
    // Manual additions are operator-pinned decider candidates. When omitted by
    // older clients, the worker treats deciderModels as the manual list.
    manualDeciderModels: z.array(BenchmarkDeciderModelSchema).optional(),
    // Auto additions are refreshed from Kilo Bench cost data by the benchmark
    // worker's scheduled sync. The effective deciderModels list is manual +
    // non-excluded auto models.
    autoDeciderModels: z.array(AutoBenchmarkDeciderModelSchema).optional(),
    excludedAutoDeciderModels: z.array(z.string().trim().min(1)).optional(),
    // Accuracy threshold for "gets the job done" (per taxonomy route).
    minAccuracy: z.number().min(0).max(1),
    // Benchmark-wide parallelism budget. Decider runs use it as a live
    // container budget; classifier runs use it for parallel OpenRouter calls.
    maxConcurrency: z.number().int().min(1).max(100),
    // The Kilo user whose identity/billing the decider CLI runs execute under.
    // Null until an admin configures it; decider runs fail fast while null.
    benchmarkUserId: z.string().trim().min(1).nullable(),
    // Optional organization context for the benchmark user. When present, the
    // CLI token and container run execute in org context so usage bills org
    // credits instead of personal credits.
    benchmarkOrgId: z.string().trim().min(1).nullable().default(null),
    // Session stickiness knob carried into published routing tables: a session
    // stays on its incumbent model while it meets the route's accuracy
    // threshold, unless the fresh pick is cheaper by more than this factor.
    // Model switches discard provider prompt caches (cache reads are far
    // cheaper than fresh input tokens), so switching only pays off when the
    // recurring savings clearly outweigh the cache-rebuild penalty.
    switchCostFactor: z.number().min(1).max(100),
    // How many times to repeat each case for classifier / decider benchmarks.
    // Repeated runs reduce variance; the default of 1 preserves the current
    // single-pass behaviour.
    classifierRepetitions: z.number().int().min(1).max(5).default(1),
    deciderRepetitions: z.number().int().min(1).max(5).default(1),
    // Maximum acceptable p95 latency for the classifier winner; null means no
    // constraint (cost-only selection).
    classifierMaxP95LatencyMs: z.number().int().positive().nullable().default(1000),
    // Auto decider model selection includes terminal-bench models whose
    // floored average run cost falls within this inclusive range.
    autoDeciderMinCostUsd: z.number().nonnegative().default(AUTO_DECIDER_DEFAULT_MIN_COST_USD),
    autoDeciderMaxCostUsd: z.number().nonnegative().default(AUTO_DECIDER_DEFAULT_MAX_COST_USD),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
  })
  .superRefine((config, ctx) => {
    addDuplicateModelIssues(config.classifierModels, 'classifierModels', ctx);
    addDuplicateModelIssues(
      config.deciderModels.map(m => m.id),
      'deciderModels',
      ctx
    );
    addDuplicateModelIssues(
      (config.manualDeciderModels ?? []).map(m => m.id),
      'manualDeciderModels',
      ctx
    );
    addDuplicateModelIssues(
      (config.autoDeciderModels ?? []).map(m => m.id),
      'autoDeciderModels',
      ctx
    );
    addDuplicateModelIssues(
      config.excludedAutoDeciderModels ?? [],
      'excludedAutoDeciderModels',
      ctx
    );
    if (config.autoDeciderMinCostUsd > config.autoDeciderMaxCostUsd) {
      ctx.addIssue({
        code: 'custom',
        path: ['autoDeciderMaxCostUsd'],
        message: 'Auto decider max cost must be greater than or equal to min cost',
      });
    }
  });
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export const AutoBenchmarkDeciderCandidatesResponseSchema = z.object({
  candidates: z.array(
    z.object({
      id: z.string().trim().min(1),
      avgAttemptCostUsd: z.number().nonnegative(),
    })
  ),
  minCostUsd: z.number().nonnegative().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
  generatedAt: z.string().optional(),
});
export type AutoBenchmarkDeciderCandidatesResponse = z.infer<
  typeof AutoBenchmarkDeciderCandidatesResponseSchema
>;

export const BenchmarkRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type BenchmarkRunStatus = z.infer<typeof BenchmarkRunStatusSchema>;

export const BenchmarkModelSummarySchema = z.object({
  model: z.string(),
  // '*' for classifier runs, otherwise "<taskType>/<subtaskType>".
  routeKey: z.union([TaxonomyRouteKeySchema, z.literal('*')]),
  accuracy: z.number(),
  avgCostUsd: z.number().nullable(),
  avgLatencyMs: z.number(),
  p50LatencyMs: z.number().nullable(),
  p95LatencyMs: z.number().nullable(),
  cases: z.number().int(),
  errors: z.number().int(),
  timeouts: z.number().int().default(0),
});
export type BenchmarkModelSummary = z.infer<typeof BenchmarkModelSummarySchema>;

export const BenchmarkRunSchema = z.object({
  id: z.string(),
  kind: BenchmarkKindSchema,
  status: BenchmarkRunStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  summaries: z.array(BenchmarkModelSummarySchema),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export const BenchmarkRunsResponseSchema = z.object({ runs: z.array(BenchmarkRunSchema) });
// config is null until an admin saves one — the worker never fabricates a
// default config, and runs cannot start without a saved one.
export const BenchmarkConfigResponseSchema = z.object({
  config: BenchmarkConfigSchema.nullable(),
});
export const StartBenchmarkRunRequestSchema = z.object({
  kind: BenchmarkKindSchema,
  // Re-run every configured model even when prior results exist.
  force: z.boolean().default(false),
});
export const StartBenchmarkRunResponseSchema = z.object({
  runId: z.string(),
  enqueuedModels: z.number().int(),
  skippedModels: z.array(z.string()).default([]),
});

export const BenchmarkRoutingTableResponseSchema = z.object({
  table: RoutingTableSchema.nullable(),
  publishedAt: z.string().nullable(),
});
export type BenchmarkRoutingTableResponse = z.infer<typeof BenchmarkRoutingTableResponseSchema>;

// The cheapest classifier candidate meeting the accuracy threshold, derived
// on read from the latest completed classifier run (served via
// /admin/classifier-winner and cached in the auto-routing KV namespace).
export const ClassifierWinnerSchema = z.object({
  model: z.string().trim().min(1),
  runId: z.string(),
  accuracy: z.number(),
  p95LatencyMs: z.number().nullable().default(null),
  generatedAt: z.string(),
});
export type ClassifierWinner = z.infer<typeof ClassifierWinnerSchema>;

export const CLASSIFIER_WINNER_KV_KEY = 'classifier_benchmark_winner';

export const ClassifierWinnerResponseSchema = z.object({
  winner: ClassifierWinnerSchema.nullable(),
});
export type ClassifierWinnerResponse = z.infer<typeof ClassifierWinnerResponseSchema>;
