import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  AutoRouter,
  BenchmarkKind,
  BenchmarkModelSummary,
  CandidatePricing,
  CustomRouterEntryRef,
  OwnerType,
  ProductionTokenProfile,
  EffortByComplexity,
  BenchmarkProfileStatus,
  BenchmarkRunPurpose,
  BenchmarkRunStatus,
  PolicySettingComputedMap,
  PolicySettingOverrides,
} from '@kilocode/auto-routing-contracts';

export type ClientProfileStatus = 'pending' | 'ready' | 'failed';

/** Storage status: `failed` is retryable, `unavailable` is permanently failed. */
export type BenchmarkProfileRowStatus = BenchmarkProfileStatus | 'unavailable';

// Migrations are generated via `pnpm db:generate` (drizzle-kit) and applied
// via wrangler d1 migrations apply.

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  router: text('router').$type<AutoRouter>().notNull().default('efficient').unique(),
  min_accuracy: real('min_accuracy').notNull(),
  accuracy_noise_band: real('accuracy_noise_band').notNull().default(0.05),
  // Legacy policy-knob columns (frontier_min_accuracy_delta, switch_cost_factor,
  // best_accuracy_switch_threshold, low_confidence_threshold,
  // classifier_repetitions, decider_repetitions, classifier_max_p95_latency_ms):
  // no longer read, and replaceConfig writes the canonical fixed policy value on
  // save. The benchmark_runs and routing_tables copies are separate and still
  // written from the resolved policy.
  frontier_min_accuracy_delta: real('frontier_min_accuracy_delta').notNull().default(0),
  switch_cost_factor: real('switch_cost_factor').notNull(),
  best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
  production_token_profile: text('production_token_profile', {
    mode: 'json',
  }).$type<ProductionTokenProfile>(),
  switch_horizon_turns: integer('switch_horizon_turns'),
  low_confidence_threshold: real('low_confidence_threshold'),
  // Legacy lane-budget columns: never read by this worker, but still read by
  // the previously deployed one, so they stay until a cleanup migration drops
  // both. replaceConfig writes values the old worker accepts; the user default is
  // migration 0010's stored default, kept so the column definition is unchanged.
  max_concurrency: integer('max_concurrency').notNull(),
  user_max_concurrency: integer('user_max_concurrency').notNull().default(100),
  benchmark_user_id: text('benchmark_user_id'),
  benchmark_org_id: text('benchmark_org_id'),
  classifier_repetitions: integer('classifier_repetitions').notNull().default(1),
  decider_repetitions: integer('decider_repetitions').notNull().default(1),
  classifier_max_p95_latency_ms: integer('classifier_max_p95_latency_ms'),
  // Admin overrides for system-optimal policy settings; null when none are set.
  policy_overrides: text('policy_overrides', { mode: 'json' }).$type<PolicySettingOverrides>(),
  // Daily system-optimal computation, keyed by policy setting. Server-owned.
  policy_computed: text('policy_computed', { mode: 'json' }).$type<PolicySettingComputedMap>(),
  updated_at: text('updated_at').notNull(),
  updated_by: text('updated_by'),
});

export const configClassifierModels = sqliteTable(
  'config_classifier_models',
  {
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    model: text('model').notNull(),
  },
  table => [primaryKey({ columns: [table.router, table.model] })]
);

export const configDeciderModels = sqliteTable(
  'config_decider_models',
  {
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    model: text('model').notNull(),
    variant: text('variant'),
    reasoning_effort: text('reasoning_effort'),
  },
  table => [primaryKey({ columns: [table.router, table.model] })]
);

export const benchmarkRuns = sqliteTable(
  'benchmark_runs',
  {
    id: text('id').primaryKey(),
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    kind: text('kind').$type<BenchmarkKind>().notNull(),
    status: text('status').$type<BenchmarkRunStatus>().notNull(),
    started_at: text('started_at').notNull(),
    completed_at: text('completed_at'),
    error: text('error'),
    // Config snapshot taken at startRun time so mid-run edits can't skew results.
    min_accuracy: real('min_accuracy').notNull(),
    accuracy_noise_band: real('accuracy_noise_band').notNull().default(0.05),
    frontier_min_accuracy_delta: real('frontier_min_accuracy_delta').notNull().default(0),
    switch_cost_factor: real('switch_cost_factor').notNull(),
    best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
    max_concurrency: integer('max_concurrency').notNull(),
    benchmark_user_id: text('benchmark_user_id'),
    benchmark_org_id: text('benchmark_org_id'),
    repetitions: integer('repetitions').notNull().default(1),
    classifier_max_p95_latency_ms: integer('classifier_max_p95_latency_ms'),
    // Benchmark-identity snapshot: dataset content hash + engine version. A prior
    // model's summaries may only be carried into a new run when this matches (and
    // repetitions + the model's reasoning_effort match), so changes to the
    // dataset, grading, or CLI/image pinning re-benchmark instead of pairing
    // current serving config with measurements taken under different conditions.
    engine_identity: text('engine_identity').notNull().default(''),
    // Which registry queue this run drained: 'platform' (saved platform decider
    // list) or 'user' (owner pools). Classifier runs are always 'platform'.
    purpose: text('purpose').$type<BenchmarkRunPurpose>().notNull().default('platform'),
    // ACTIVE_MEASUREMENT_REVISION the run started under: which cases it runs and how it grades them.
    // Runs from before the column existed measured revision 2.
    measurement_revision: integer('measurement_revision').notNull().default(2),
    // Post-cutover admission provenance: written only by the Worker that owns the paid
    // flow. Null on every row an older Worker wrote, which is exactly how a run admitted
    // during the deploy overlap is recognized and fenced — wall clock proves nothing.
    // NULL means never claimable, initializable or dispatchable again.
    admission_marker: text('admission_marker'),
  },
  table => [
    // Decider queues run several runs at once; a classifier run derives one winner.
    uniqueIndex('UQ_benchmark_runs_one_running_classifier_per_router_purpose')
      .on(table.router, table.purpose)
      .where(sql`${table.status} = 'running' AND ${table.kind} = 'classifier'`),
    index('IX_benchmark_runs_running')
      .on(table.router, table.kind, table.purpose)
      .where(sql`${table.status} = 'running'`),
  ]
);

export const runModels = sqliteTable(
  'run_models',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    // Application code converts '' ↔ null at the edges.
    variant: text('variant').notNull().default(''),
    // enqueued=false means the model was skipped (had prior results).
    enqueued: integer('enqueued', { mode: 'boolean' }).notNull(),
    // Legacy mirror of the platform effort key; kept for rollback/provenance.
    reasoning_effort: text('reasoning_effort'),
  },
  table => [primaryKey({ columns: [table.run_id, table.model, table.variant] })]
);

export const modelSummaries = sqliteTable(
  'model_summaries',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    variant: text('variant').notNull().default(''),
    route_key: text('route_key').notNull(),
    accuracy: real('accuracy').notNull(),
    avg_cost_usd: real('avg_cost_usd'),
    avg_input_tokens: real('avg_input_tokens'),
    avg_cached_input_tokens: real('avg_cached_input_tokens'),
    avg_output_tokens: real('avg_output_tokens'),
    avg_reasoning_tokens: real('avg_reasoning_tokens'),
    avg_latency_ms: real('avg_latency_ms').notNull(),
    p50_latency_ms: real('p50_latency_ms'),
    cases: integer('cases').notNull(),
    // Rows whose cost_usd was reported: the denominator of avg_cost_usd. Null
    // on rows written before it was captured, which the console reads as
    // "unknown", never as "every case was priced".
    costed_cases: integer('costed_cases'),
    errors: integer('errors').notNull(),
    p95_latency_ms: real('p95_latency_ms'),
    timeouts: integer('timeouts').notNull().default(0),
    // Classifier summaries only; null for decider summaries and older rows.
    route_accuracy: real('route_accuracy'),
    // carried=true rows are prior-run summaries copied in at startRun for skipped models.
    carried: integer('carried', { mode: 'boolean' }).notNull().default(false),
  },
  table => [primaryKey({ columns: [table.run_id, table.model, table.variant, table.route_key] })]
);

export const caseResults = sqliteTable(
  'case_results',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    variant: text('variant').notNull().default(''),
    case_id: text('case_id').notNull(),
    route_key: text('route_key'),
    score: real('score').notNull(),
    latency_ms: integer('latency_ms').notNull(),
    cost_usd: real('cost_usd'),
    input_tokens: integer('input_tokens'),
    cached_input_tokens: integer('cached_input_tokens'),
    output_tokens: integer('output_tokens'),
    reasoning_tokens: integer('reasoning_tokens'),
    error: text('error'),
    // Unused since the System One classifier cutover; kept so old-code upserts
    // during a rolling deploy still succeed.
    fallback_reason: text('fallback_reason'),
    // Classifier diagnostics: predicted taskType/subtaskType matched the golden
    // route key. Null for decider rows and older classifier rows.
    route_hit: integer('route_hit', { mode: 'boolean' }),
    // Decider diagnostics.
    retried: integer('retried', { mode: 'boolean' }),
    exit_code: integer('exit_code'),
    output_prefix: text('output_prefix'),
    event_count: integer('event_count'),
    last_event_types: text('last_event_types'),
    // Tool evidence of the measured turn (src/kilo-events.ts ToolEvidence); null before it was
    // recorded. tool_names is a JSON array of distinct names in first-use order.
    tool_calls: integer('tool_calls'),
    tool_names: text('tool_names'),
    step_count: integer('step_count'),
    final_finish_reason: text('final_finish_reason'),
    // Repetition index (0-based); together with run_id/model/variant/case_id forms the PK.
    rep: integer('rep').notNull().default(0),
    // 1 when the case was killed by the wall-clock timeout, 0 otherwise.
    timed_out: integer('timed_out').notNull().default(0),
    // Measurement revision (src/measurement-revision.ts) of the call that produced this result.
    prompt_revision: integer('prompt_revision').notNull().default(1),
  },
  // The composite PK's leftmost column already serves run_id-prefix lookups
  // (count/fetch by run); no separate run_id index is needed.
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.variant, table.case_id, table.rep] }),
  ]
);

export const pendingDeciderOutputs = sqliteTable(
  'pending_decider_outputs',
  {
    run_id: text('run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    case_id: text('case_id').notNull(),
    rep: integer('rep').notNull(),
    payload: text('payload').notNull(),
    prompt_revision: integer('prompt_revision').notNull().default(1),
    grading_token: text('grading_token'),
    grading_lease_until: integer('grading_lease_until').notNull().default(0),
  },
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.variant, table.case_id, table.rep] }),
  ]
);

export const schedulerChunks = sqliteTable(
  'scheduler_chunks',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    // Retired: nothing reads it, and writers store '[]'. SQLite's DROP COLUMN rewrites
    // every row of this large table, and the previous worker still writes it until
    // this release is deployed, so the column stays.
    providers: text('providers').notNull(),
    rep: integer('rep').notNull(),
    chunk: integer('chunk').notNull(),
    case_ids: text('case_ids').notNull(),
    status: text('status')
      .$type<'pending' | 'queued' | 'active' | 'completed' | 'failed'>()
      .notNull()
      .default('pending'),
    token: text('token'),
    slot: integer('slot'),
    lease_until: integer('lease_until').notNull().default(0),
    available_at: integer('available_at').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    throttle_deferrals: integer('throttle_deferrals').notNull().default(0),
    catalog_deferrals: integer('catalog_deferrals').notNull().default(0),
  },
  table => [
    index('IX_scheduler_chunks_pending').on(table.status, table.available_at),
    index('IX_scheduler_chunks_run').on(table.run_id),
    // Lane-head dispatch: a lane is one (run, model, variant, rep) chunk chain, and
    // `(available_at, chunk)` orders its runnable head. This prefix lets a claim
    // find each lane's next runnable chunk by index seek instead of scanning the
    // run's or the backlog's pending rows.
    index('IX_scheduler_chunks_lane').on(
      table.status,
      table.run_id,
      table.model,
      table.variant,
      table.rep,
      table.available_at,
      table.chunk
    ),
    uniqueIndex('UQ_scheduler_chunks_live_slot')
      .on(table.slot)
      .where(sql`${table.status} IN ('queued', 'active')`),
  ]
);

export const schedulerRuns = sqliteTable('scheduler_runs', {
  run_id: text('run_id')
    .primaryKey()
    .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
});

export const schedulerExecutions = sqliteTable(
  'scheduler_executions',
  {
    run_id: text('run_id')
      .notNull()
      .references(() => benchmarkRuns.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    token: text('token').notNull(),
    started_at: integer('started_at').notNull().default(0),
    // The prompt transport the worker that opened this paid call used, so a container
    // result recovered by a later deploy is stored under the transport that produced it.
    // A pre-migration worker leaves the default, which is the argv transport.
    prompt_revision: integer('prompt_revision').notNull().default(1),
  },
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.variant, table.rep, table.case_id] }),
  ]
);

/**
 * Scheduler lease rows. Row 1 serializes dispatch passes: a pass holds the lease while
 * it reads live occupancy and claims; another dispatcher that finds the lease held
 * returns immediately and the next completion or cron wake retries. Model and slot
 * caps are only exact if one pass at a time reads occupancy.
 * Row 2, created on first use, serializes run initialization passes. Row 3 is a
 * production deploy's intent: while its lease is unexpired, no new dispatch pass takes
 * row 1, so the deploy takes row 1 when the current pass ends.
 */
export const schedulerDispatchLock = sqliteTable('scheduler_dispatch_lock', {
  id: integer('id').primaryKey(),
  token: text('token'),
  lease_until: integer('lease_until').notNull().default(0),
});

/**
 * Per-model throttle deadlines. Cooling is stored here rather than stamped onto
 * every pending chunk so one throttle event costs a bounded write instead of
 * rewriting the whole backlog. Rows of the retired `provider` scope only expire.
 */
export const schedulerCooldowns = sqliteTable(
  'scheduler_cooldowns',
  {
    scope: text('scope').$type<'model' | 'provider' | 'catalog'>().notNull(),
    key: text('key').notNull(),
    until: integer('until').notNull(),
  },
  table => [primaryKey({ columns: [table.scope, table.key] })]
);

/**
 * Single row (id = 1) of admin scheduler overrides. A null limit falls back to
 * `BENCHMARK_SCHEDULER_CONFIG`, then the default. Dispatch reads it by primary key.
 */
export const schedulerSettings = sqliteTable('scheduler_settings', {
  id: integer('id').primaryKey(),
  slots: integer('slots'),
  model_concurrency: integer('model_concurrency'),
  // Retired provider limits, no longer read or written. The previous worker still
  // selects them until this release is deployed, and migrations apply before the
  // deploy, so they are dropped in a later migration.
  provider_concurrency: integer('provider_concurrency'),
  unknown_provider_concurrency: integer('unknown_provider_concurrency'),
  updated_at: text('updated_at').notNull(),
  updated_by: text('updated_by'),
});

export const routingTables = sqliteTable('routing_tables', {
  run_id: text('run_id').primaryKey(),
  router: text('router').$type<AutoRouter>().notNull().default('efficient'),
  published_at: text('published_at').notNull(),
  generated_at: text('generated_at').notNull(),
  min_accuracy: real('min_accuracy').notNull(),
  accuracy_noise_band: real('accuracy_noise_band'),
  switch_cost_factor: real('switch_cost_factor').notNull(),
  best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
  production_token_profile: text('production_token_profile', {
    mode: 'json',
  }).$type<ProductionTokenProfile>(),
  switch_horizon_turns: integer('switch_horizon_turns'),
  low_confidence_threshold: real('low_confidence_threshold'),
  effort_by_complexity: text('effort_by_complexity', { mode: 'json' }).$type<EffortByComplexity>(),
  source: text('source').notNull(),
  // Exact published platform membership, so a republish is gated on a real desired-set
  // change rather than on ranked routes (a configured-but-ineligible pair is absent).
  desired_pairs: text('desired_pairs', { mode: 'json' }).$type<string[]>(),
});

/**
 * Single row (id = 1) marking the first scheduler pass after the paid cutover. Pending
 * work that predates it is parked instead of resurrected into a paid flow.
 */
export const benchmarkCutover = sqliteTable('benchmark_cutover', {
  id: integer('id').primaryKey(),
  cutover_at: text('cutover_at').notNull(),
});

/**
 * One row per base router: a monotonic counter bumped by the `benchmark_profiles` triggers in the
 * migration that adds this table, so any committed readiness or provenance change to a profile
 * advances it inside the same transaction. The serving Worker reads this single row through the
 * benchmark service binding before it trusts a cached custom routing table.
 */
export const benchmarkReadinessEpoch = sqliteTable('benchmark_readiness_epoch', {
  router: text('router').$type<AutoRouter>().primaryKey().notNull(),
  epoch: integer('epoch').notNull().default(0),
  updated_at: text('updated_at').notNull(),
});

export const routingTableCandidates = sqliteTable(
  'routing_table_candidates',
  {
    run_id: text('run_id').notNull(),
    route_key: text('route_key').notNull(),
    rank: integer('rank').notNull(),
    model: text('model').notNull(),
    accuracy: real('accuracy').notNull(),
    cases: integer('cases'),
    // Non-null unlike model_summaries: RankedCandidate.avgCostUsd is a plain
    // nonnegative number (buildRoutingTable excludes summaries without a
    // cost signal, so every published candidate has one).
    avg_cost_usd: real('avg_cost_usd').notNull(),
    meets_threshold: integer('meets_threshold', { mode: 'boolean' }).notNull(),
    // Legacy effort key; platform table JSON still reads this column.
    reasoning_effort: text('reasoning_effort'),
    // Exact-pair identity mirror ('' = null). Keeps rows self-describing; no PK change.
    variant: text('variant').notNull().default(''),
    pricing: text('pricing', { mode: 'json' }).$type<CandidatePricing>(),
    estimated_request_cost_usd: real('estimated_request_cost_usd'),
    p50_latency_ms: real('p50_latency_ms'),
    p50_ttft_ms: real('p50_ttft_ms'),
  },
  table => [primaryKey({ columns: [table.run_id, table.route_key, table.rank] })]
);

/**
 * Global Benchmark-profile registry: one current row per exact benchmark pair per
 * engine identity + repetitions. Old-engine rows remain as history; currency
 * is decided by matching the live decider engine identity and repetitions.
 */
export const benchmarkProfiles = sqliteTable(
  'benchmark_profiles',
  {
    model: text('model').notNull(),
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    status: text('status').$type<BenchmarkProfileRowStatus>().notNull(),
    // Provenance of the run that measured / is measuring this profile.
    run_id: text('run_id'),
    failure_reason: text('failure_reason'),
    // Failure history since the last ready measurement, kept through requeue and re-run
    // so the retry budgets count consecutive failed runs. Read through parseProfileState.
    failure_class: text('failure_class'),
    failure_attempts: integer('failure_attempts').notNull().default(0),
    model_failure_attempts: integer('model_failure_attempts').notNull().default(0),
    first_failed_at: text('first_failed_at'),
    retry_after: text('retry_after'),
    invalidated_at: text('invalidated_at'),
    requested_at: text('requested_at').notNull(),
    updated_at: text('updated_at').notNull(),
    completed_at: text('completed_at'),
    // Who wants this measurement. Both can be set — the registry row is global
    // and shared, so a pair wanted by the platform list and by an owner pool is
    // measured once and serves both.
    // ponytail: set-once flags, not reference counts. A pending row an owner has
    // since dropped from their pool is still measured. Add refcounting only if
    // wasted runs show up in the numbers.
    platform_requested: integer('platform_requested', { mode: 'boolean' }).notNull().default(false),
    user_requested: integer('user_requested', { mode: 'boolean' }).notNull().default(true),
  },
  table => [
    primaryKey({
      columns: [table.router, table.model, table.variant, table.engine_identity, table.repetitions],
    }),
  ]
);

export const benchmarkSubscriptions = sqliteTable(
  'benchmark_subscriptions',
  {
    router: text('router').$type<AutoRouter>().notNull(),
    owner_type: text('owner_type').$type<'platform' | 'user' | 'org'>().notNull(),
    owner_id: text('owner_id').notNull(),
    revision: text('revision').notNull(),
    snapshot: text('snapshot').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [primaryKey({ columns: [table.router, table.owner_type, table.owner_id] })]
);

/**
 * Progress of one day's alias sync, per router. The daily cron starts it and the minute
 * cron resumes it while the row says work is left: whether the platform aliases were
 * re-resolved, and a keyset cursor over owner subscriptions. `attempts` bounds how much
 * the day may repeat after a failure.
 */
export const benchmarkDailyAliasSync = sqliteTable('benchmark_daily_alias_sync', {
  router: text('router').$type<AutoRouter>().primaryKey(),
  day: text('day').notNull(),
  attempts: integer('attempts').notNull().default(0),
  platform_status: text('platform_status')
    .$type<'pending' | 'ok' | 'failed'>()
    .notNull()
    .default('pending'),
  platform_error: text('platform_error'),
  owner_cursor_type: text('owner_cursor_type').$type<'user' | 'org'>(),
  owner_cursor_id: text('owner_cursor_id'),
  owner_pages: integer('owner_pages').notNull().default(0),
  owner_done: integer('owner_done').notNull().default(0),
  updated_at: text('updated_at').notNull(),
});

/**
 * Ready registry rows queued to re-measure the cases the revision-1 prompt transport
 * measured unreliably. Kept beside the profile so the profile stays `ready` on its
 * previous run and keeps serving: a run claims the row (`run_id`), copies the previous
 * run's other results, measures the affected cases, and only on completion moves the
 * profile's provenance to the new run.
 */
export const profileRemeasures = sqliteTable(
  'profile_remeasures',
  {
    router: text('router').$type<AutoRouter>().notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    run_id: text('run_id'),
    requested_at: text('requested_at').notNull(),
    claimed_at: text('claimed_at'),
  },
  table => [
    primaryKey({
      columns: [table.router, table.model, table.variant, table.engine_identity, table.repetitions],
    }),
    index('IDX_profile_remeasures_run').on(table.run_id),
  ]
);

/**
 * One-shot activation queue for a measurement revision: `remeasure` rows to queue in
 * `profile_remeasures` and `readmit` rows to move back to `pending`, both written by the
 * activating migration and consumed by the drain of the worker that ships with it
 * (`applyProbeActivations` in `src/probe-activation.ts`).
 *
 * The rows exist only so the activation can ship as reviewed data before the new image
 * is live: a migration applies before the container deploy, and the worker still serving
 * during that window claims `profile_remeasures` rows and `pending` profiles directly, so
 * a queue row written by the migration itself would be measured at the old revision. That
 * worker never reads this table, and the apply is a no-op while the active revision is
 * below the row's `required_revision` (see `applyProbeActivations`).
 */
export const probeActivations = sqliteTable(
  'probe_activations',
  {
    router: text('router').$type<AutoRouter>().notNull(),
    /** `remeasure` queues the pair in `profile_remeasures`; `readmit` re-admits it. */
    action: text('action').$type<'remeasure' | 'readmit'>().notNull(),
    /**
     * The measurement revision the action needs. `applyProbeActivations` is a no-op below
     * it and leaves the row staged, so deploying a worker that starts runs under an older
     * `ACTIVE_MEASUREMENT_REVISION` never moves a row it cannot measure yet.
     */
    required_revision: integer('required_revision').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    requested_at: text('requested_at').notNull(),
  },
  table => [
    primaryKey({
      columns: [
        table.router,
        table.action,
        table.model,
        table.variant,
        table.engine_identity,
        table.repetitions,
      ],
    }),
  ]
);

/**
 * Rolling owner admission ledger for the 24h profile request quota, counted per
 * base router. One row per charged model admission (new under current engine, or
 * explicit failed retry). Stale engine-drift re-admissions are free and do not
 * insert here.
 */
export const profileRequestEvents = sqliteTable(
  'profile_request_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner_type: text('owner_type').notNull(),
    owner_id: text('owner_id').notNull(),
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    admitted_at: text('admitted_at').notNull(),
  },
  table => [
    index('IDX_profile_request_events_owner_router_admitted').on(
      table.owner_type,
      table.owner_id,
      table.router,
      table.admitted_at
    ),
  ]
);

/**
 * Owner-scoped measurements uploaded by the owner's CLI (ADR 0005). Never shared
 * with another owner, never read by the platform table, never promoted to
 * `benchmark_profiles`. The rollup columns summarize `client_case_results`;
 * `results` guards concurrent rollups so the most complete view wins.
 */
export const clientProfiles = sqliteTable(
  'client_profiles',
  {
    id: text('id').primaryKey(),
    owner_type: text('owner_type').$type<OwnerType>().notNull(),
    owner_id: text('owner_id').notNull(),
    router: text('router').$type<AutoRouter>().notNull(),
    entry_kind: text('entry_kind').$type<CustomRouterEntryRef['kind']>().notNull(),
    // '' for gateway entries.
    provider: text('provider').notNull().default(''),
    model: text('model').notNull(),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    status: text('status').$type<ClientProfileStatus>().notNull(),
    failure_reason: text('failure_reason'),
    results: integer('results').notNull().default(0),
    accuracy: real('accuracy'),
    errors: integer('errors').notNull().default(0),
    timeouts: integer('timeouts').notNull().default(0),
    avg_cost_usd: real('avg_cost_usd'),
    p50_latency_ms: real('p50_latency_ms'),
    p95_latency_ms: real('p95_latency_ms'),
    route_summaries: text('route_summaries', { mode: 'json' })
      .$type<BenchmarkModelSummary[]>()
      .notNull()
      .default(sql`'[]'`),
    // Last upload revision handed out for this profile. Never decreases, so a case deleted
    // and uploaded again gets a revision no earlier rollup view has seen.
    upload_seq: integer('upload_seq').notNull().default(0),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    uniqueIndex('UQ_client_profiles_identity').on(
      table.owner_type,
      table.owner_id,
      table.router,
      table.entry_kind,
      table.provider,
      table.model,
      table.variant,
      table.engine_identity,
      table.repetitions
    ),
  ]
);

export const clientCaseResults = sqliteTable(
  'client_case_results',
  {
    profile_id: text('profile_id')
      .notNull()
      .references(() => clientProfiles.id, { onDelete: 'cascade' }),
    case_id: text('case_id').notNull(),
    rep: integer('rep').notNull(),
    route_key: text('route_key').notNull(),
    output: text('output').notNull(),
    cost_usd: real('cost_usd').notNull(),
    duration_ms: integer('duration_ms').notNull(),
    exit_code: integer('exit_code'),
    timed_out: integer('timed_out', { mode: 'boolean' }).notNull(),
    score: real('score').notNull(),
    grader_cost_usd: real('grader_cost_usd').notNull(),
    uploaded_at: text('uploaded_at').notNull(),
    // This upload's revision from the profile's `upload_seq`, unique within the profile even
    // across same-millisecond uploads and delete-and-reinsert; the rollup guard compares it.
    revision: integer('revision').notNull().default(0),
    // Grader usage the usage writer has not acknowledged yet; a retried upload resends it.
    pending_grader_usage: text('pending_grader_usage'),
  },
  table => [primaryKey({ columns: [table.profile_id, table.case_id, table.rep] })]
);

/**
 * Judged grading claim for one client upload. A case identity has at most one row, and only
 * the holder of its `token` runs the paid judge, so parallel uploads of the same case cannot
 * each pay for a grading the usage ledger records once. An expired lease is taken over by
 * the next upload; the holder removes its row when its grading ends.
 */
export const clientCaseGradingClaims = sqliteTable(
  'client_case_grading_claims',
  {
    profile_id: text('profile_id')
      .notNull()
      .references(() => clientProfiles.id, { onDelete: 'cascade' }),
    case_id: text('case_id').notNull(),
    rep: integer('rep').notNull(),
    token: text('token').notNull(),
    // Epoch milliseconds after which a vanished holder's claim no longer blocks a retry.
    lease_until: integer('lease_until').notNull(),
    created_at: text('created_at').notNull(),
  },
  table => [primaryKey({ columns: [table.profile_id, table.case_id, table.rep] })]
);

/**
 * Lane-death ledger: one row per benchmark queue message that exhausted its
 * retries and dead-lettered. Written by the DLQ consumer; read by run
 * finalization so a dead lane no longer wedges its run — profile runs complete
 * per-entry, platform runs fail fast instead of waiting for the stale sweep.
 */
export const runLaneFailures = sqliteTable(
  'run_lane_failures',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // Canonical variant key at the D1 boundary. '' means null/default variant.
    variant: text('variant').notNull().default(''),
    rep: integer('rep').notNull().default(0),
    chunk: integer('chunk').notNull().default(0),
    shard: integer('shard').notNull().default(0),
    failed_at: text('failed_at').notNull(),
    // Null on rows written before lane causes were recorded.
    failure_class: text('failure_class'),
  },
  table => [
    primaryKey({
      columns: [table.run_id, table.model, table.variant, table.rep, table.chunk, table.shard],
    }),
  ]
);

export type PaidBenchmarkRequestRowStatus =
  | 'preparing'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed';

export type PaidBenchmarkRequestCaseRowStatus =
  | 'queued'
  | 'running'
  | 'reused'
  | 'done'
  | 'failed'
  | 'paused';

/**
 * A case run's lifecycle. `settled` means a valid result was committed; `cancelled`
 * and `failed` never charge a user. One generation owns a case run at a time, and
 * every transition is conditioned on (executor_run_id, executor_token, generation)
 * so a callback from an earlier attempt cannot settle a newer one.
 */
export type PaidCaseRunRowStatus =
  | 'queued'
  | 'running'
  | 'settled'
  // The payer ran out of funds: the slot stops dispatching but is not a failure and the
  // run itself stays healthy. Distinct from `cancelled` (explicit last voluntary pause).
  | 'paused'
  | 'cancelled'
  | 'failed';

/**
 * Per-account eligibility for one case-run generation. `detached` removes an account that
 * failed billing from future assignment while its earlier usage receipts stay. `accepted`
 * is the account whose usage was recorded; `closed` is terminal bookkeeping.
 */
export type PaidCasePayerStatus = 'eligible' | 'detached' | 'accepted' | 'closed';

/**
 * One native model request: selecting → admitted → used (native receipt accepted) →
 * completed, or refused (a trusted pre-upstream payment refusal).
 */
export type PaidModelRequestState = 'selecting' | 'admitted' | 'used' | 'completed' | 'refused';

export type PaidCaseCancellationStatus = 'pending' | 'delivered';

/** The only billing-adjacent effect D1 still writes: post-completion pin bookkeeping. */
export type PaidBillingOutboxKind = 'pins';

/** No automatic terminal status: a monetary intent retries until it is delivered. */
export type PaidBillingOutboxStatus = 'pending' | 'delivered' | 'abandoned';

/**
 * One explicit user confirmation ('start') with its bound quote. Never created by a
 * pool edit, subscription sync, alias scan, schedule or retry.
 */
export const paidBenchmarkRequests = sqliteTable(
  'paid_benchmark_requests',
  {
    id: text('id').primaryKey(),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    organization_id: text('organization_id'),
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    router_id: text('router_id').notNull(),
    pool_version: text('pool_version').notNull(),
    engine_identity: text('engine_identity').notNull(),
    status: text('status').$type<PaidBenchmarkRequestRowStatus>().notNull(),
    quote_id: text('quote_id').notNull(),
    estimate_microdollars: integer('estimate_microdollars').notNull(),
    // The displayed maximum. Usage is billed just-in-time per model request; this is
    // the amount the user approved, never a post-hoc D1 charge.
    maximum_microdollars: integer('maximum_microdollars').notNull(),
    // Accepted usage observed for this request's attached attempts (display only).
    charged_microdollars: integer('charged_microdollars').notNull().default(0),
    // The approved plan's case count and how many are durably staged. Activation
    // requires them equal, so approval is never derived from a partially written plan.
    plan_cases: integer('plan_cases').notNull().default(0),
    staged_cases: integer('staged_cases').notNull().default(0),
    // `no_funds` is the native payer's balance refusal; `owner` is a voluntary pause.
    // The reviewed forecast is advisory only (no threshold-driven pause). A case
    // cancelled because its last voluntary payer left is a case-level close reason.
    pause_reason: text('pause_reason').$type<'no_funds' | 'owner'>(),
    actor_user_id: text('actor_user_id').notNull(),
    // Immutable pool context the quote was bound to.
    context: text('context').notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    activated_at: text('activated_at'),
    paused_at: text('paused_at'),
    completed_at: text('completed_at'),
    failure_reason: text('failure_reason'),
    failure_retryable: integer('failure_retryable', { mode: 'boolean' }).notNull().default(false),
  },
  table => [
    index('IX_paid_benchmark_requests_owner').on(
      table.owner_type,
      table.owner_id,
      table.router_id,
      table.created_at
    ),
    index('IX_paid_benchmark_requests_status').on(table.status, table.updated_at),
    // One live request per saved pool: a hidden second start would keep spending after
    // the visible request is paused. Completed/failed rows do not block a fresh start.
    uniqueIndex('UQ_paid_benchmark_requests_live_router')
      .on(table.router_id)
      .where(sql`${table.status} IN ('preparing', 'active')`),
  ]
);

/**
 * An expiring quote the user saw before clicking. `plan` is the selected case plan
 * (case keys, per-case estimate, reused/covered/shared counts), bound to the owner,
 * pool version, engine identity and context hash so a request cannot be started for a
 * different pool or case set than the one priced.
 */
export const paidBenchmarkQuotes = sqliteTable(
  'paid_benchmark_quotes',
  {
    id: text('id').primaryKey(),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    organization_id: text('organization_id'),
    router: text('router').$type<AutoRouter>().notNull().default('efficient'),
    router_id: text('router_id').notNull(),
    pool_version: text('pool_version').notNull(),
    engine_identity: text('engine_identity').notNull(),
    context: text('context').notNull(),
    plan: text('plan').notNull(),
    estimate_microdollars: integer('estimate_microdollars').notNull(),
    maximum_microdollars: integer('maximum_microdollars').notNull(),
    // Number of case slots the approved plan stages before a request may activate.
    plan_cases: integer('plan_cases').notNull().default(0),
    expires_at: text('expires_at').notNull(),
    // Set by the one start that consumes the quote; a second start is rejected.
    started_request_id: text('started_request_id'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    index('IX_paid_benchmark_quotes_owner').on(table.owner_type, table.owner_id, table.expires_at),
  ]
);

/** One row per requested case slot: the displayed per-case progress and receipt. */
export const paidBenchmarkRequestCases = sqliteTable(
  'paid_benchmark_request_cases',
  {
    request_id: text('request_id')
      .notNull()
      .references(() => paidBenchmarkRequests.id, { onDelete: 'cascade' }),
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    status: text('status').$type<PaidBenchmarkRequestCaseRowStatus>().notNull(),
    covered_by_kilo: integer('covered_by_kilo', { mode: 'boolean' }).notNull().default(false),
    charged_microdollars: integer('charged_microdollars').notNull().default(0),
    reason: text('reason'),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    primaryKey({
      columns: [
        table.request_id,
        table.engine_identity,
        table.model,
        table.variant,
        table.rep,
        table.case_id,
      ],
    }),
    index('IX_paid_benchmark_request_cases_status').on(table.request_id, table.status),
  ]
);

/**
 * The cross-run case-key claim fence: one row per (engine identity, model, variant,
 * repetition, case). A row is created queued by a paid request or claimed running by
 * the executor chunk that will measure it. The primary key IS the fence, so two
 * admitters of the same case run cannot both start inference.
 */
export const benchmarkCaseRuns = sqliteTable(
  'benchmark_case_runs',
  {
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    status: text('status').$type<PaidCaseRunRowStatus>().notNull(),
    // Incremented when a cancelled or failed generation is revived by a new paid
    // attempt, so callbacks of the old attempt are fenced.
    generation: integer('generation').notNull().default(1),
    executor_run_id: text('executor_run_id'),
    executor_token: text('executor_token'),
    // Sticky: once the platform asked for this case run, it pays it even if the pair
    // leaves the platform pool before settlement.
    platform_covered: integer('platform_covered', { mode: 'boolean' }).notNull().default(false),
    // A usable result exists for this case run (including one recovered after a
    // cancel), so it is never measured or charged again.
    result_usable: integer('result_usable', { mode: 'boolean' }).notNull().default(false),
    cost_microdollars: integer('cost_microdollars'),
    // Marks the settlement batch that froze this generation's payer set and output.
    settlement_id: text('settlement_id'),
    failure_reason: text('failure_reason'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    started_at: text('started_at'),
    settled_at: text('settled_at'),
  },
  table => [
    primaryKey({
      columns: [table.engine_identity, table.model, table.variant, table.rep, table.case_id],
    }),
    index('IX_benchmark_case_runs_executor').on(table.executor_run_id),
    index('IX_benchmark_case_runs_status').on(table.status, table.updated_at),
  ]
);

/**
 * Per-account eligibility for one case-run generation (one case, one measuring attempt).
 * A `detached` account can no longer be selected; its receipts remain. Selection,
 * admission and receipts are keyed by the model request UUID in `paid_model_requests`,
 * and repeat calls of the same case rotate accounts by the generation's accepted count.
 */
export const benchmarkCasePayers = sqliteTable(
  'benchmark_case_payers',
  {
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    generation: integer('generation').notNull(),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    request_id: text('request_id').notNull(),
    status: text('status').$type<PaidCasePayerStatus>().notNull(),
    reason: text('reason'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    primaryKey({
      columns: [
        table.engine_identity,
        table.model,
        table.variant,
        table.rep,
        table.case_id,
        table.generation,
        table.owner_type,
        table.owner_id,
        table.request_id,
      ],
    }),
    index('IX_benchmark_case_payers_owner').on(table.owner_type, table.owner_id, table.status),
    index('IX_benchmark_case_payers_request').on(table.request_id, table.status),
  ]
);

/**
 * One native model request (one upstream call) of one case-run generation. The UUID is
 * the client/model request id, so a duplicated HTTP delivery is the same row. `state`
 * is the single authority: only an `admitted` row may reach the provider, and only its
 * `assignment_id` can be admitted or detached, so a retried request cannot double-admit.
 * A refused row keeps its candidate trail in `paid_model_request_attempts`.
 */
export const paidModelRequests = sqliteTable(
  'paid_model_requests',
  {
    id: text('id').primaryKey(),
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    generation: integer('generation').notNull(),
    // The request the case belongs to (display/aggregation, not the billing unit).
    pool_request_id: text('pool_request_id'),
    state: text('state').$type<PaidModelRequestState>().notNull().default('selecting'),
    // The payer account the current selection/admission is pinned to.
    assignment_id: text('assignment_id'),
    // Gateway call identity, for the authenticated admit callback.
    api: text('api'),
    executor_user_id: text('executor_user_id'),
    project_id: text('project_id'),
    usage_id: text('usage_id'),
    // The organization the platform charged for a covered model request. Part of the
    // signed assignment, so it is only stored and returned, never inferred.
    platform_organization_id: text('platform_organization_id'),
    owner_type: text('owner_type').$type<'user' | 'organization'>(),
    owner_id: text('owner_id'),
    platform_covered: integer('platform_covered', { mode: 'boolean' }).notNull().default(false),
    reason: text('reason'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    index('IX_paid_model_requests_case').on(
      table.engine_identity,
      table.model,
      table.variant,
      table.rep,
      table.case_id,
      table.generation
    ),
    index('IX_paid_model_requests_state').on(table.state, table.updated_at),
  ]
);

/**
 * Selection trail of one model request: one row per attempted payer candidate. A
 * `refused` attempt is the auditable reason another account was tried; it never bills.
 */
export const paidModelRequestAttempts = sqliteTable(
  'paid_model_request_attempts',
  {
    model_request_id: text('model_request_id')
      .notNull()
      .references(() => paidModelRequests.id, { onDelete: 'cascade' }),
    assignment_id: text('assignment_id').notNull(),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    pool_request_id: text('pool_request_id').notNull(),
    status: text('status').$type<'selected' | 'refused' | 'accepted'>().notNull(),
    reason: text('reason'),
    ordinal: integer('ordinal').notNull().default(0),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  table => [
    primaryKey({ columns: [table.model_request_id, table.assignment_id] }),
    index('IX_paid_model_request_attempts_pool').on(table.pool_request_id, table.status),
  ]
);

/**
 * Read-only accounting receipt for usage the native usage writer billed against a model
 * request. One row per native usage id, so a replay cannot double count; D1 never sends a
 * charge from this table. `model_request_id` keeps the owner scope for progress totals.
 */
export const paidAttemptUsage = sqliteTable(
  'paid_attempt_usage',
  {
    usage_id: text('usage_id').primaryKey(),
    model_request_id: text('model_request_id').notNull(),
    request_id: text('request_id').notNull(),
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    generation: integer('generation').notNull(),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    microdollars: integer('microdollars').notNull(),
    platform_covered: integer('platform_covered', { mode: 'boolean' }).notNull().default(false),
    created_at: text('created_at').notNull(),
  },
  table => [
    // One receipt per model request: a second native usage id for the same admitted call
    // is a mismatch and must not write accounting.
    uniqueIndex('UQ_paid_attempt_usage_model_request').on(table.model_request_id),
    index('IX_paid_attempt_usage_request').on(table.request_id, table.created_at),
    // Covered-call lookup for shared cases: a covered receipt has no paying pool request,
    // so progress must find it by the case key alone. Partial, so it stays tiny relative
    // to the request-scoped rows the other indexes serve.
    index('IX_paid_attempt_usage_covered_case')
      .on(table.engine_identity, table.model, table.variant, table.rep, table.case_id)
      .where(sql`${table.platform_covered} = 1`),
    // Per-case aggregates for progress read this index only for the request's own rows.
    index('IX_paid_attempt_usage_case').on(
      table.request_id,
      table.engine_identity,
      table.model,
      table.variant,
      table.rep,
      table.case_id,
      table.platform_covered
    ),
  ]
);

/**
 * Durable cancellation intent for a running generation. The case run is fenced the
 * moment its terminal transition commits; this row carries the exact
 * (run, token, generation) that must be signalled and is retried until delivered.
 */
export const paidCaseCancellations = sqliteTable(
  'paid_benchmark_cancellations',
  {
    engine_identity: text('engine_identity').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull(),
    rep: integer('rep').notNull(),
    case_id: text('case_id').notNull(),
    generation: integer('generation').notNull(),
    executor_run_id: text('executor_run_id').notNull(),
    executor_token: text('executor_token').notNull(),
    status: text('status').$type<PaidCaseCancellationStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    available_at: integer('available_at').notNull().default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    delivered_at: integer('delivered_at'),
    last_error: text('last_error'),
  },
  table => [
    primaryKey({
      columns: [
        table.engine_identity,
        table.model,
        table.variant,
        table.rep,
        table.case_id,
        table.generation,
      ],
    }),
    index('IX_paid_benchmark_cancellations_pending').on(table.status, table.available_at),
  ]
);

/**
 * Durable billing intent outbox. `seq` is the delivery order (a pause release always
 * follows the charges it settles); `id` is a deterministic operation id, so a replayed
 * D1 batch cannot duplicate a hold, a charge or a release.
 */
export const paidBillingOutbox = sqliteTable(
  'paid_benchmark_billing_outbox',
  {
    seq: integer('seq').primaryKey(),
    id: text('id').notNull().unique(),
    kind: text('kind').$type<PaidBillingOutboxKind>().notNull(),
    request_id: text('request_id').notNull(),
    case_engine_identity: text('case_engine_identity'),
    case_model: text('case_model'),
    case_variant: text('case_variant'),
    case_rep: integer('case_rep'),
    case_id: text('case_id'),
    owner_type: text('owner_type').$type<'user' | 'organization'>().notNull(),
    owner_id: text('owner_id').notNull(),
    amount_microdollars: integer('amount_microdollars').notNull(),
    status: text('status').$type<PaidBillingOutboxStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    available_at: integer('available_at').notNull().default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    delivered_at: integer('delivered_at'),
    last_error: text('last_error'),
  },
  table => [index('IX_paid_benchmark_billing_outbox_pending').on(table.status, table.available_at)]
);

/**
 * One row per measured attempt of a benchmark pair, from the run ledger. It records the
 * attempt outcome (completed / failed / unavailable) with the failure class and reason,
 * so a pair that fails with no progress across attempts can be classified permanently
 * unavailable from history. Create-table only: pre-ledger attempts stay unknown and no
 * existing profile status is rewritten.
 */
export const profileAttemptHistory = sqliteTable(
  'profile_attempt_history',
  {
    router: text('router').$type<AutoRouter>().notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    run_id: text('run_id').notNull(),
    repetitions: integer('repetitions').notNull(),
    outcome: text('outcome').notNull(),
    failure_class: text('failure_class'),
    failure_reason: text('failure_reason'),
    attempted_at: text('attempted_at').notNull(),
  },
  table => [
    primaryKey({
      columns: [table.router, table.model, table.variant, table.engine_identity, table.run_id],
    }),
    index('IDX_profile_attempt_history_pair_time').on(
      table.router,
      table.model,
      table.variant,
      table.engine_identity,
      table.attempted_at
    ),
  ]
);
