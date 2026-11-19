import * as z from 'zod';
import {
  CustomRoutingTableSchema,
  EfficientModelPoolSchema,
  BenchmarkPairSchema,
  PoolEntrySchema,
  poolEntryKey,
  benchmarkPairKey,
  RoutingTableSchema,
} from './routing-table';
import { ReasoningEffortSchema, refineVariantExclusivity, VariantSchema } from './reasoning';
import { addDuplicateKeyIssues } from './duplicate-keys';
import { TaxonomyRouteKeySchema } from './taxonomy';
import { AutoRouterSchema, DEFAULT_AUTO_ROUTER, type AutoRouter } from './router';
import { OwnerIdentityShape } from './owner';
import {
  POLICY_SETTING_VALUE_DEFAULTS,
  POLICY_SETTING_VALUE_SCHEMAS,
  PolicySettingComputedMapSchema,
  PolicySettingOverridesSchema,
  PolicySettingsStateSchema,
} from './policy-settings';

export const BenchmarkKindSchema = z.enum(['classifier', 'decider']);
export type BenchmarkKind = z.infer<typeof BenchmarkKindSchema>;

/**
 * Which registry queue a run drains. Decider measurements all land in the one
 * global Benchmark-profile registry; the purpose only records who asked for the
 * entries — the saved platform decider list ('platform') or owner pools
 * ('user'). Each purpose owns its own decider slot, so the two queues run
 * independently; both draw on the shared container budget. Classifier runs
 * are always 'platform'.
 */
export const BenchmarkRunPurposeSchema = z.enum(['platform', 'user']);
export type BenchmarkRunPurpose = z.infer<typeof BenchmarkRunPurposeSchema>;

/** Queue selector for a manual decider run. 'both' starts one run per queue. */
export const BenchmarkQueueSelectorSchema = z.enum(['platform', 'user', 'both']);
export type BenchmarkQueueSelector = z.infer<typeof BenchmarkQueueSelectorSchema>;

/**
 * Total live decider containers the benchmark runner may hold, shared by every
 * router and queue. Each queue job holds one container for its consumer
 * invocation, so this equals Cloudflare's limit of 250 concurrent push-consumer
 * invocations. Raising it needs a Cloudflare limit increase plus matching
 * container `max_instances` and jobs consumer `max_concurrency` in wrangler.jsonc.
 */
export const BENCHMARK_CONTAINER_BUDGET = 250;

/** Scheduler limits an admin can override at runtime, without a deploy. */
export const BENCHMARK_SCHEDULER_SETTING_KEYS = [
  'slots',
  'modelConcurrency',
  'providerConcurrency',
  'unknownProviderConcurrency',
] as const;
export const BenchmarkSchedulerSettingKeySchema = z.enum(BENCHMARK_SCHEDULER_SETTING_KEYS);
export type BenchmarkSchedulerSettingKey = z.infer<typeof BenchmarkSchedulerSettingKeySchema>;

export const BenchmarkSchedulerLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(BENCHMARK_CONTAINER_BUDGET);

/**
 * Admin scheduler overrides. PUT replaces the whole set: a null or missing limit
 * falls back to the worker's `BENCHMARK_SCHEDULER_CONFIG`, then its default.
 */
export const BenchmarkSchedulerOverridesSchema = z.strictObject(
  Object.fromEntries(
    BENCHMARK_SCHEDULER_SETTING_KEYS.map(key => [
      key,
      BenchmarkSchedulerLimitSchema.nullable().default(null),
    ])
  ) as Record<
    BenchmarkSchedulerSettingKey,
    z.ZodDefault<z.ZodNullable<typeof BenchmarkSchedulerLimitSchema>>
  >
);
export type BenchmarkSchedulerOverrides = z.infer<typeof BenchmarkSchedulerOverridesSchema>;

export const BenchmarkSchedulerSettingSourceSchema = z.enum(['admin', 'env', 'default']);
export type BenchmarkSchedulerSettingSource = z.infer<typeof BenchmarkSchedulerSettingSourceSchema>;

/** `fallback` is the env or default value the setting returns to without an override. */
export const BenchmarkSchedulerSettingSchema = z.object({
  effective: BenchmarkSchedulerLimitSchema,
  source: BenchmarkSchedulerSettingSourceSchema,
  override: BenchmarkSchedulerLimitSchema.nullable(),
  fallback: BenchmarkSchedulerLimitSchema,
});
export type BenchmarkSchedulerSetting = z.infer<typeof BenchmarkSchedulerSettingSchema>;

export const BenchmarkSchedulerConfigResponseSchema = z.object({
  settings: z.record(BenchmarkSchedulerSettingKeySchema, BenchmarkSchedulerSettingSchema),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type BenchmarkSchedulerConfigResponse = z.infer<
  typeof BenchmarkSchedulerConfigResponseSchema
>;

/** Exact model/effort identity in persisted benchmark run snapshots. */
export const BenchmarkDeciderModelSchema = z
  .object({
    id: z.string().trim().min(1),
    // Canonical catalog variant key. Legacy run snapshots may omit it.
    variant: VariantSchema.optional(),
    // Legacy snapshot identity; new benchmark writers emit variant only.
    reasoningEffort: ReasoningEffortSchema.nullable().default(null),
  })
  .superRefine((model, ctx) => refineVariantExclusivity(model, ctx, 'Decider model'));
export type BenchmarkDeciderModel = z.infer<typeof BenchmarkDeciderModelSchema>;

/** Platform selectors choose models; the current catalog supplies every effort. */
export const BenchmarkPlatformModelSchema = z.object({
  id: z.string().trim().min(1),
});
export type BenchmarkPlatformModel = z.infer<typeof BenchmarkPlatformModelSchema>;

export const DEFAULT_BENCHMARK_DECIDER_MODEL_IDS: Record<AutoRouter, string> = {
  efficient: '~deepseek/deepseek-flash-latest',
  frontier: '~openai/gpt-sol-latest',
};

// Decider runs mint their CLI token from apps/web's internal bot-token
// endpoint, which only issues for `bot-internal-*` bot users in an org.
export const INTERNAL_BOT_USER_ID_PREFIX = 'bot-internal-';
export const DEFAULT_BENCHMARK_USER_ID = 'bot-internal-benchmark';
export const DEFAULT_BENCHMARK_ORG_ID = '9d278969-5453-4ae3-a51f-a8d2274a7b56';

// Retired per-config concurrency knobs (maxConcurrency, userMaxConcurrency) are
// gone from the contract: container lanes come from the shared budget in
// BENCHMARK_CONTAINER_BUDGET. Zod strips the stale keys from payloads a
// previous admin UI or a stored config still sends.
const { minAccuracy, accuracyNoiseBand, productionTokenProfile, switchHorizonTurns } =
  POLICY_SETTING_VALUE_SCHEMAS;

export const BenchmarkConfigSchema = z
  .object({
    router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
    classifierModels: z.array(z.string().trim().min(1)).min(1),
    deciderModels: z.array(BenchmarkPlatformModelSchema).min(1).optional(),
    // The editable policy fields, derived from the shared declarations in
    // policy-settings.ts. The fixed policy settings have no config field left,
    // so a stored config or old admin payload carrying one parses with that key
    // stripped, like the retired concurrency knobs above.
    // Accuracy threshold for "gets the job done" (per taxonomy route).
    minAccuracy,
    accuracyNoiseBand: accuracyNoiseBand.default(POLICY_SETTING_VALUE_DEFAULTS.accuracyNoiseBand),
    // Optional override for the Kilo user whose identity/billing the decider
    // CLI runs execute under. Null means the worker uses DEFAULT_BENCHMARK_USER_ID.
    // The effective user must be an internal bot (`bot-internal-*`).
    benchmarkUserId: z.string().trim().min(1).nullable(),
    // Optional override for the organization context. Null means the worker
    // uses DEFAULT_BENCHMARK_ORG_ID.
    benchmarkOrgId: z.string().trim().min(1).nullable().default(null),
    productionTokenProfile: productionTokenProfile
      .nullable()
      .default(POLICY_SETTING_VALUE_DEFAULTS.productionTokenProfile),
    switchHorizonTurns: switchHorizonTurns
      .nullable()
      .default(POLICY_SETTING_VALUE_DEFAULTS.switchHorizonTurns),
    // Admin overrides for system-optimal policy settings. Null/absent entries
    // mean "use the computed value". Server-owned: the computed map is never
    // written through this schema.
    policyOverrides: PolicySettingOverridesSchema.nullable().optional(),
    policyComputed: PolicySettingComputedMapSchema.nullable().optional(),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
  })
  .transform(config => ({
    ...config,
    deciderModels: config.deciderModels ?? [
      { id: DEFAULT_BENCHMARK_DECIDER_MODEL_IDS[config.router] },
    ],
  }))
  // Flags each list entry whose (trimmed) id already appeared earlier in the
  // array. Model ids are the D1 primary keys for config_classifier_models /
  // config_decider_models, so duplicates would otherwise reach the DB as an
  // opaque constraint violation (HTTP 500) instead of an actionable 400.
  .superRefine((config, ctx) => {
    addDuplicateKeyIssues(config.classifierModels, ctx, id => id, {
      pathPrefix: ['classifierModels'],
      message: id => `Duplicate model id: ${id}`,
    });
    addDuplicateKeyIssues(config.deciderModels, ctx, model => model.id, {
      pathPrefix: ['deciderModels'],
      message: id => `Duplicate model id: ${id}`,
    });
  });
export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;

/**
 * Fixed policy fields the previous web release still requires in the admin
 * config response. Production deploys this worker before the web promotion
 * (ADR 0003 invariant 7), so the response keeps them, projected from the
 * resolved policy, until that release is promoted. Remove this schema with the
 * projection in the worker's admin routes.
 */
export const BenchmarkConfigAdminLegacyFieldsSchema = z.object({
  frontierMinAccuracyDelta: POLICY_SETTING_VALUE_SCHEMAS.frontierMinAccuracyDelta,
  switchCostFactor: POLICY_SETTING_VALUE_SCHEMAS.switchCostFactor,
  bestAccuracySwitchThreshold: POLICY_SETTING_VALUE_SCHEMAS.bestAccuracySwitchThreshold,
  lowConfidenceThreshold: POLICY_SETTING_VALUE_SCHEMAS.lowConfidenceThreshold.nullable(),
  classifierRepetitions: POLICY_SETTING_VALUE_SCHEMAS.classifierRepetitions,
  deciderRepetitions: POLICY_SETTING_VALUE_SCHEMAS.deciderRepetitions,
  classifierMaxP95LatencyMs: POLICY_SETTING_VALUE_SCHEMAS.classifierMaxP95LatencyMs.nullable(),
});
export type BenchmarkConfigAdminLegacyFields = z.infer<
  typeof BenchmarkConfigAdminLegacyFieldsSchema
>;

/** Admin config response body: the editable config plus the transitional fields. */
export type BenchmarkConfigAdminResponseConfig = BenchmarkConfig & BenchmarkConfigAdminLegacyFields;

export type BenchmarkIdentity = { benchmarkUserId: string; benchmarkOrgId: string };
export type BenchmarkIdentityOverrides = Pick<
  BenchmarkConfig,
  'benchmarkUserId' | 'benchmarkOrgId'
>;

/** A saved identity override the bot-token mint would refuse. */
export class BenchmarkIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchmarkIdentityError';
  }
}

export function resolveBenchmarkIdentity(config: BenchmarkIdentityOverrides): BenchmarkIdentity {
  const benchmarkUserId = config.benchmarkUserId ?? DEFAULT_BENCHMARK_USER_ID;
  if (!benchmarkUserId.startsWith(INTERNAL_BOT_USER_ID_PREFIX)) {
    throw new BenchmarkIdentityError(
      `benchmarkUserId override "${benchmarkUserId}" is not an internal bot user; ` +
        `use a ${INTERNAL_BOT_USER_ID_PREFIX}* user or clear the override`
    );
  }
  return {
    benchmarkUserId,
    benchmarkOrgId: config.benchmarkOrgId ?? DEFAULT_BENCHMARK_ORG_ID,
  };
}

export const BenchmarkRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type BenchmarkRunStatus = z.infer<typeof BenchmarkRunStatusSchema>;

export const BenchmarkModelSummarySchema = z.object({
  model: z.string(),
  // Exact-pair identity for summary rows. Optional so already-persisted run
  // payloads and old admin-UI responses still parse. Null = default/no variant.
  variant: VariantSchema.optional(),
  // '*' for classifier runs, otherwise "<taskType>/<subtaskType>".
  routeKey: z.union([TaxonomyRouteKeySchema, z.literal('*')]),
  accuracy: z.number(),
  avgCostUsd: z.number().nullable(),
  avgLatencyMs: z.number(),
  p50LatencyMs: z.number().nullable(),
  p50TtftMs: z.number().nonnegative().nullable().optional(),
  p95LatencyMs: z.number().nullable(),
  cases: z.number().int(),
  errors: z.number().int(),
  timeouts: z.number().int().default(0),
  // Classifier runs only: share of cases whose predicted taskType/subtaskType
  // equals the golden route key, the only axes the decision engine reads.
  // Null for decider runs and for classifier runs recorded before it existed.
  routeAccuracy: z.number().min(0).max(1).nullable().default(null),
  // Mean tokens per graded case, as the CLI reports them on `step_finish`: input excludes cache
  // reads, output excludes reasoning. Null for summaries recorded before token capture.
  avgInputTokens: z.number().nonnegative().nullable().optional(),
  avgCachedInputTokens: z.number().nonnegative().nullable().optional(),
  avgOutputTokens: z.number().nonnegative().nullable().optional(),
  avgReasoningTokens: z.number().nonnegative().nullable().optional(),
});
export type BenchmarkModelSummary = z.infer<typeof BenchmarkModelSummarySchema>;

// Live case tally for a running run. `totalCases` is null when the expected
// total cannot be derived exactly (the dataset changed after the run started),
// so a reader shows counts without a completion estimate.
export const BenchmarkRunProgressSchema = z.object({
  completedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative().nullable(),
  failedCases: z.number().int().nonnegative(),
});
export type BenchmarkRunProgress = z.infer<typeof BenchmarkRunProgressSchema>;

export const BenchmarkRunSchema = z.object({
  id: z.string(),
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  kind: BenchmarkKindSchema,
  // Defaulted so run payloads persisted before the field existed still parse.
  purpose: BenchmarkRunPurposeSchema.default('platform'),
  status: BenchmarkRunStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  // Optional so run payloads persisted before the field existed still parse.
  // Omitted for terminal runs, whose counts are already final in `summaries`.
  progress: BenchmarkRunProgressSchema.optional(),
  summaries: z.array(BenchmarkModelSummarySchema),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export const BenchmarkRunsResponseSchema = z.object({ runs: z.array(BenchmarkRunSchema) });
// config is null until an admin saves one — the worker never fabricates a
// default config, and runs cannot start without a saved one.
export const BenchmarkConfigResponseSchema = z.object({
  config: BenchmarkConfigSchema.nullable(),
  // Per-setting effective/computed/override resolution. Null when no config is
  // saved; optional so PUT responses from an older worker still parse.
  policySettings: PolicySettingsStateSchema.nullable().optional(),
});
export const StartBenchmarkRunRequestSchema = z.object({
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  kind: BenchmarkKindSchema,
  // Re-run every configured model even when prior results exist. Classifier
  // only — decider dedup is the registry's job.
  force: z.boolean().default(false),
  // Which registry queue a decider run drains. Ignored for classifier runs.
  queue: BenchmarkQueueSelectorSchema.default('platform'),
});
export const StartedBenchmarkRunSchema = z.object({
  runId: z.string(),
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
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
  // One entry per queue that could not start. Reported even when another queue
  // did start, or a wedged queue would read as "nothing pending".
  drainErrors: z.array(z.string()).default([]),
});

/**
 * Wire status for a Benchmark profile. Presentation maps pending/running to
 * "Benchmarking"; "Unavailable" is a web-derived state and never a wire status.
 */
export const BenchmarkProfileStatusSchema = z.enum(['pending', 'running', 'ready', 'failed']);
export type BenchmarkProfileStatus = z.infer<typeof BenchmarkProfileStatusSchema>;
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
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  repetitions: z.number().int(),
  platform: BenchmarkRegistryQueueSchema,
  user: BenchmarkRegistryQueueSchema,
  platformEntries: z
    .array(
      z.object({
        model: z.string().trim().min(1),
        variant: VariantSchema,
        status: BenchmarkProfileStatusSchema,
      })
    )
    .optional(),
});
export type BenchmarkRegistryResponse = z.infer<typeof BenchmarkRegistryResponseSchema>;

export const RequeueBenchmarkRegistryRequestSchema = z.object({
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  scope: BenchmarkQueueSelectorSchema,
});
export const RequeueBenchmarkRegistryResponseSchema = z.object({
  requeued: z.number().int(),
});

export const RefreshBenchmarkProfilesRequestSchema = z.object({
  router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
  mode: z.enum(['refresh', 'repair_unavailable']),
  entries: z
    .array(
      BenchmarkPairSchema.refine(entry => !entry.model.startsWith('~'), {
        message: 'Refresh requires concrete model IDs.',
      })
    )
    .min(1)
    .max(100)
    .superRefine((entries, ctx) => {
      addDuplicateKeyIssues(entries, ctx, benchmarkPairKey, {
        message: () => 'Duplicate benchmark pair.',
      });
    }),
});
export type RefreshBenchmarkProfilesRequest = z.infer<typeof RefreshBenchmarkProfilesRequestSchema>;

export const RefreshBenchmarkProfilesResponseSchema = z.object({
  refreshed: z.array(BenchmarkPairSchema),
  unavailable: z.array(BenchmarkPairSchema),
  skipped: z.array(BenchmarkPairSchema),
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
  // Marks a winner measured by the System One classifier. A winner from a
  // benchmark worker that predates the cutover lacks it and fails to parse, so
  // the auto-routing worker falls back to DEFAULT_CLASSIFIER_MODEL whatever the
  // deploy order.
  engine: z.literal('system-one'),
  model: z.string().trim().min(1),
  runId: z.string(),
  accuracy: z.number(),
  p95LatencyMs: z.number().nullable().default(null),
  generatedAt: z.string(),
});
export type ClassifierWinner = z.infer<typeof ClassifierWinnerSchema>;

// Renamed at the System One cutover so a cached chat-model winner is never read.
export const CLASSIFIER_WINNER_KV_KEY = 'classifier_system_one_winner';

export const ClassifierWinnerResponseSchema = z.object({
  winner: ClassifierWinnerSchema.nullable(),
});
export type ClassifierWinnerResponse = z.infer<typeof ClassifierWinnerResponseSchema>;

// Benchmark profile registry (global per exact measurement pair + engine).

/** Bounded failure text stored on failed profile rows. */
export const BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH = 500;

export const BenchmarkProfileEntryStatusSchema = z.object({
  entry: BenchmarkPairSchema,
  status: BenchmarkProfileStatusSchema,
  failureReason: z.string().max(BENCHMARK_PROFILE_FAILURE_REASON_MAX_LENGTH).nullable().optional(),
});
export type BenchmarkProfileEntryStatus = z.infer<typeof BenchmarkProfileEntryStatusSchema>;

export const RegisterBenchmarkProfilesRequestSchema = z
  .object({
    router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
    ...OwnerIdentityShape,
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
export type RegisterBenchmarkProfilesRequest = z.input<
  typeof RegisterBenchmarkProfilesRequestSchema
>;

export const SyncBenchmarkSubscriptionsRequestSchema = z.object({
  ...OwnerIdentityShape,
  entries: EfficientModelPoolSchema.nullable(),
  restorePrevious: z.boolean().optional(),
});
export type SyncBenchmarkSubscriptionsRequest = z.infer<
  typeof SyncBenchmarkSubscriptionsRequestSchema
>;

/**
 * Owner-scoped Efficient model pool request. Two endpoints take exactly this
 * body — benchmark profile status and the custom routing table — and both names
 * below stay exported so each call site keeps its own contract name.
 */
const OwnerScopedPoolRequestSchema = z
  .object({
    router: AutoRouterSchema.default(DEFAULT_AUTO_ROUTER),
    ...z.object(OwnerIdentityShape).partial().shape,
    entries: EfficientModelPoolSchema,
  })
  .superRefine((request, ctx) => {
    if ((request.ownerType === undefined) !== (request.ownerId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [request.ownerType === undefined ? 'ownerType' : 'ownerId'],
        message: 'ownerType and ownerId must be provided together',
      });
    }
  });

export const BenchmarkProfileStatusesRequestSchema = OwnerScopedPoolRequestSchema;
export type BenchmarkProfileStatusesRequest = z.input<typeof BenchmarkProfileStatusesRequestSchema>;

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

export const CustomRoutingTableRequestSchema = OwnerScopedPoolRequestSchema;
export type CustomRoutingTableRequest = z.input<typeof CustomRoutingTableRequestSchema>;

export const CustomRoutingTableResponseSchema = z.object({
  table: CustomRoutingTableSchema.nullable(),
});
export type CustomRoutingTableResponse = z.infer<typeof CustomRoutingTableResponseSchema>;
