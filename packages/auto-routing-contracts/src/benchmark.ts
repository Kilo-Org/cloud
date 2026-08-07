import * as z from 'zod';
import {
  CustomRoutingTableSchema,
  EfficientModelPoolSchema,
  PoolEntrySchema,
  poolEntryKey,
  RoutingTableSchema,
} from './routing-table';
import { ReasoningEffortSchema } from './reasoning';
import { TaxonomyRouteKeySchema } from './taxonomy';

export { ReasoningEffortSchema } from './reasoning';
export type { ReasoningEffort } from './reasoning';

// Matches AutoRoutingModeOwnerTypeSchema in index.ts. Declared here (not
// imported) to avoid a circular package-root dependency.
const BenchmarkProfileOwnerTypeSchema = z.enum(['user', 'org']);

export const BenchmarkKindSchema = z.enum(['classifier', 'decider']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

/**
 * Which registry queue a run drains. Decider measurements all land in the one
 * global Benchmark-profile registry; the purpose only records who asked for the
 * entries — the saved platform decider list ('platform') or owner pools
 * ('user'). Each purpose owns its own decider slot and container budget, so the
 * two queues run independently. Classifier runs are always 'platform'.
 */
export const BenchmarkRunPurposeSchema = z.enum(['platform', 'user']);
export type BenchmarkRunPurpose = z.infer<typeof BenchmarkRunPurposeSchema>;

/** Queue selector for a manual decider run. 'both' starts one run per queue. */
export const BenchmarkQueueSelectorSchema = z.enum(['platform', 'user', 'both']);
export type BenchmarkQueueSelector = z.infer<typeof BenchmarkQueueSelectorSchema>;

/**
 * Total live decider containers the benchmark runner may hold (wrangler
 * `max_instances`). Platform and profile runs are independent, so their
 * configured lane budgets must sum to at most this.
 */
export const BENCHMARK_CONTAINER_BUDGET = 200;

/**
 * Decider model identity for a benchmark run. Platform/admin config still
 * selects one legacy `reasoningEffort` per model. Profile runs (and exact
 * Pool-entry identity) use canonical `variant`. Both non-null is malformed —
 * same both-set rule as RankedCandidate / decisions.
 */
export const BenchmarkDeciderModelSchema = z
  .object({
    id: z.string().trim().min(1),
    // Canonical catalog variant key. Optional so platform admin config (effort
    // only) still parses. Prefer this over reasoningEffort for new writers.
    variant: z.string().trim().min(1).nullable().optional(),
    // Passed to the kilo CLI as --variant during the benchmark and carried into
    // the platform routing table so serving uses the same effort the model was
    // graded with. Null for models without (or not using) configurable
    // reasoning. Legacy; prefer `variant` when present.
    reasoningEffort: ReasoningEffortSchema.nullable().default(null),
  })
  .superRefine((model, ctx) => {
    if (model.variant != null && model.reasoningEffort != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['variant'],
        message: 'Decider model must not set both variant and reasoningEffort; emit variant only',
      });
    }
  });
export type BenchmarkDeciderModel = z.infer<typeof BenchmarkDeciderModelSchema>;

export const AUTO_DECIDER_DEFAULT_MIN_COST_USD = 15;
export const AUTO_DECIDER_DEFAULT_MAX_COST_USD = 25;
export const DEFAULT_BENCHMARK_USER_ID = 'ce12ef3d-ae95-4d77-b4f0-23735f0a0591';
export const DEFAULT_BENCHMARK_ORG_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

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
    // Platform parallelism budget. Platform decider runs use it as a live
    // container budget; classifier runs use it for parallel OpenRouter calls.
    maxConcurrency: z.number().int().min(1).max(BENCHMARK_CONTAINER_BUDGET),
    // Live container budget for user-queue runs. Separate from maxConcurrency so
    // a user-queue run and a platform-queue run can hold containers at once.
    userMaxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(BENCHMARK_CONTAINER_BUDGET)
      .default(BENCHMARK_CONTAINER_BUDGET / 2),
    // Optional override for the Kilo user whose identity/billing the decider
    // CLI runs execute under. Null means the worker uses DEFAULT_BENCHMARK_USER_ID.
    benchmarkUserId: z.string().trim().min(1).nullable(),
    // Optional override for the organization context. Null means the worker
    // uses DEFAULT_BENCHMARK_ORG_ID.
    benchmarkOrgId: z.string().trim().min(1).nullable().default(null),
    // Session stickiness knob carried into published routing tables: a session
    // stays on its incumbent model while it meets the route's accuracy
    // threshold, unless the fresh pick is cheaper by more than this factor.
    // Model switches discard provider prompt caches (cache reads are far
    // cheaper than fresh input tokens), so switching only pays off when the
    // recurring savings clearly outweigh the cache-rebuild penalty.
    switchCostFactor: z.number().min(1).max(100),
    // Absolute accuracy delta required before best-accuracy mode switches away
    // from a session incumbent that still meets the route threshold.
    bestAccuracySwitchThreshold: z.number().min(0).max(1).default(0.05),
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
    // Platform-queue and user-queue runs can hold containers at the same time,
    // so the two budgets share one hard platform cap.
    if (config.maxConcurrency + config.userMaxConcurrency > BENCHMARK_CONTAINER_BUDGET) {
      ctx.addIssue({
        code: 'custom',
        path: ['userMaxConcurrency'],
        message: `Max concurrency + user max concurrency must be at most ${BENCHMARK_CONTAINER_BUDGET}`,
      });
    }
  });
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

export function resolveBenchmarkIdentity(
  config: Pick<BenchmarkConfig, 'benchmarkUserId' | 'benchmarkOrgId'>
): { benchmarkUserId: string; benchmarkOrgId: string } {
  return {
    benchmarkUserId: config.benchmarkUserId ?? DEFAULT_BENCHMARK_USER_ID,
    benchmarkOrgId: config.benchmarkOrgId ?? DEFAULT_BENCHMARK_ORG_ID,
  };
}

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
  // Exact-pair identity for summary rows. Optional so already-persisted run
  // payloads and old admin-UI responses still parse. Null = default/no variant.
  variant: z.string().trim().min(1).nullable().optional(),
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
  // Defaulted so run payloads persisted before the field existed still parse.
  purpose: BenchmarkRunPurposeSchema.default('platform'),
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
  // Re-run every configured model even when prior results exist. Classifier
  // only — decider dedup is the registry's job.
  force: z.boolean().default(false),
  // Which registry queue a decider run drains. Ignored for classifier runs.
  queue: BenchmarkQueueSelectorSchema.default('platform'),
});
export const StartedBenchmarkRunSchema = z.object({
  runId: z.string(),
  purpose: BenchmarkRunPurposeSchema,
  entryCount: z.number().int(),
});
export type StartedBenchmarkRun = z.infer<typeof StartedBenchmarkRunSchema>;
export const StartBenchmarkRunResponseSchema = z.object({
  // Null when a queue drain found no pending work — nothing was started.
  runId: z.string().nullable(),
  enqueuedModels: z.number().int(),
  skippedModels: z.array(z.string()).default([]),
  // One entry per run actually started. 'both' can start two.
  startedRuns: z.array(StartedBenchmarkRunSchema).default([]),
});

/** Registry row counts for one queue, under the live engine identity. */
export const BenchmarkRegistryQueueSchema = z.object({
  pending: z.number().int(),
  running: z.number().int(),
  ready: z.number().int(),
  failed: z.number().int(),
});
export type BenchmarkRegistryQueue = z.infer<typeof BenchmarkRegistryQueueSchema>;

/**
 * Snapshot of the global decider registry. A pair wanted by both the platform
 * list and an owner pool is counted in both queues — it is one row, measured
 * once, and shared.
 */
export const BenchmarkRegistryResponseSchema = z.object({
  engineIdentity: z.string(),
  repetitions: z.number().int(),
  platform: BenchmarkRegistryQueueSchema,
  user: BenchmarkRegistryQueueSchema,
});
export type BenchmarkRegistryResponse = z.infer<typeof BenchmarkRegistryResponseSchema>;

export const RequeueBenchmarkRegistryRequestSchema = z.object({
  scope: BenchmarkQueueSelectorSchema,
});
export const RequeueBenchmarkRegistryResponseSchema = z.object({
  requeued: z.number().int(),
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

// --- Benchmark profile registry (global per Pool entry + engine) ---

/**
 * Wire status for a Benchmark profile. Presentation maps pending/running to
 * "Benchmarking"; "Unavailable" is a web-derived state and never a wire status.
 */
export const BenchmarkProfileStatusSchema = z.enum(['pending', 'running', 'ready', 'failed']);
export type BenchmarkProfileStatus = z.infer<typeof BenchmarkProfileStatusSchema>;

/** Bounded failure text stored on failed profile rows. */
export const BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH = 500;

export const BenchmarkProfileEntryStatusSchema = z.object({
  entry: PoolEntrySchema,
  status: BenchmarkProfileStatusSchema,
  failureReason: z.string().max(BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH).nullable().optional(),
});
export type BenchmarkProfileEntryStatus = z.infer<typeof BenchmarkProfileEntryStatusSchema>;

export const RegisterBenchmarkProfilesRequestSchema = z
  .object({
    ownerType: BenchmarkProfileOwnerTypeSchema,
    ownerId: z.string().trim().min(1),
    entries: EfficientModelPoolSchema,
    // Subset of `entries` the owner explicitly retries after a terminal failure.
    // Absent/empty means no explicit retries (failed current profiles are reported
    // without re-admission).
    retryEntries: z.array(PoolEntrySchema).optional(),
  })
  .superRefine((request, ctx) => {
    if (!request.retryEntries || request.retryEntries.length === 0) return;
    const entryKeys = new Set(request.entries.map(poolEntryKey));
    request.retryEntries.forEach((entry, index) => {
      const key = poolEntryKey(entry);
      if (!entryKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['retryEntries', index],
          message: `retryEntry must appear in entries: ${key}`,
        });
      }
    });
  });
export type RegisterBenchmarkProfilesRequest = z.infer<
  typeof RegisterBenchmarkProfilesRequestSchema
>;

export const BenchmarkProfileStatusesRequestSchema = z.object({
  entries: EfficientModelPoolSchema,
});
export type BenchmarkProfileStatusesRequest = z.infer<typeof BenchmarkProfileStatusesRequestSchema>;

export const BenchmarkProfileStatusesResponseSchema = z.object({
  statuses: z.array(BenchmarkProfileEntryStatusSchema),
});
export type BenchmarkProfileStatusesResponse = z.infer<
  typeof BenchmarkProfileStatusesResponseSchema
>;

/** 429 body when an owner exceeds the rolling 24h profile admission limit. */
export const BenchmarkProfileQuotaErrorSchema = z.object({
  error: z.string(),
  // ISO timestamp when the owner may request new benchmarks again.
  retryAt: z.string(),
});
export type BenchmarkProfileQuotaError = z.infer<typeof BenchmarkProfileQuotaErrorSchema>;

export const CustomRoutingTableRequestSchema = z.object({
  entries: EfficientModelPoolSchema,
});
export type CustomRoutingTableRequest = z.infer<typeof CustomRoutingTableRequestSchema>;

export const CustomRoutingTableResponseSchema = z.object({
  table: CustomRoutingTableSchema.nullable(),
});
export type CustomRoutingTableResponse = z.infer<typeof CustomRoutingTableResponseSchema>;
