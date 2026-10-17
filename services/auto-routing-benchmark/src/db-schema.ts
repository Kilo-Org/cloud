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
  CustomRouterScope,
  ProductionTokenProfile,
  EffortByComplexity,
  BenchmarkProfileStatus,
  BenchmarkRunPurpose,
  BenchmarkRunStatus,
  PolicySettingComputedMap,
  PolicySettingOverrides,
} from '@kilocode/auto-routing-contracts';

export type ClientProfileStatus = 'pending' | 'ready' | 'failed';

// Migrations are generated via `pnpm db:generate` (drizzle-kit) and applied
// via wrangler d1 migrations apply.

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  router: text('router').$type<AutoRouter>().notNull().default('efficient').unique(),
  min_accuracy: real('min_accuracy').notNull(),
  accuracy_noise_band: real('accuracy_noise_band').notNull().default(0.05),
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
  },
  table => [
    uniqueIndex('UQ_benchmark_runs_one_running_per_router_kind_purpose')
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
    avg_latency_ms: real('avg_latency_ms').notNull(),
    p50_latency_ms: real('p50_latency_ms'),
    cases: integer('cases').notNull(),
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
    // Repetition index (0-based); together with run_id/model/variant/case_id forms the PK.
    rep: integer('rep').notNull().default(0),
    // 1 when the case was killed by the wall-clock timeout, 0 otherwise.
    timed_out: integer('timed_out').notNull().default(0),
    // PROMPT_TRANSPORT_REVISION of the CLI call that produced this result.
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
  },
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.variant, table.rep, table.case_id] }),
  ]
);

/**
 * Scheduler lease rows. Row 1 serializes dispatch passes: a pass holds the lease while
 * it reads live occupancy and claims; another dispatcher that finds the lease held
 * returns immediately and the next completion or cron wake retries. Model,
 * provider and slot caps are only exact if one pass at a time reads occupancy.
 * Row 2, created on first use, serializes run initialization passes.
 */
export const schedulerDispatchLock = sqliteTable('scheduler_dispatch_lock', {
  id: integer('id').primaryKey(),
  token: text('token'),
  lease_until: integer('lease_until').notNull().default(0),
});

/**
 * Model- and provider-wide throttle deadlines. Cooling is stored here rather than
 * stamped onto every pending chunk so one throttle event costs a bounded write
 * instead of rewriting the whole backlog.
 */
export const schedulerCooldowns = sqliteTable(
  'scheduler_cooldowns',
  {
    scope: text('scope').$type<'model' | 'provider'>().notNull(),
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
  switch_cost_factor: real('switch_cost_factor').notNull(),
  best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
  production_token_profile: text('production_token_profile', {
    mode: 'json',
  }).$type<ProductionTokenProfile>(),
  switch_horizon_turns: integer('switch_horizon_turns'),
  low_confidence_threshold: real('low_confidence_threshold'),
  effort_by_complexity: text('effort_by_complexity', { mode: 'json' }).$type<EffortByComplexity>(),
  source: text('source').notNull(),
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
    status: text('status').$type<BenchmarkProfileStatus>().notNull(),
    // Provenance of the run that measured / is measuring this profile.
    run_id: text('run_id'),
    failure_reason: text('failure_reason'),
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
    owner_type: text('owner_type').$type<CustomRouterScope>().notNull(),
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
  },
  table => [
    primaryKey({
      columns: [table.run_id, table.model, table.variant, table.rep, table.chunk, table.shard],
    }),
  ]
);
