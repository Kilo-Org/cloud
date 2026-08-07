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
  BenchmarkKind,
  BenchmarkProfileStatus,
  BenchmarkRunPurpose,
  BenchmarkRunStatus,
} from '@kilocode/auto-routing-contracts';

// Migrations are generated via `pnpm db:generate` (drizzle-kit) and applied
// via wrangler d1 migrations apply.

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  min_accuracy: real('min_accuracy').notNull(),
  switch_cost_factor: real('switch_cost_factor').notNull(),
  best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
  max_concurrency: integer('max_concurrency').notNull(),
  // Live container budget for user-queue runs, independent of max_concurrency
  // (the platform-queue budget). The two must sum to at most the platform
  // container cap; the config contract enforces that at the write boundary.
  user_max_concurrency: integer('user_max_concurrency').notNull().default(100),
  benchmark_user_id: text('benchmark_user_id'),
  benchmark_org_id: text('benchmark_org_id'),
  classifier_repetitions: integer('classifier_repetitions').notNull().default(1),
  decider_repetitions: integer('decider_repetitions').notNull().default(1),
  classifier_max_p95_latency_ms: integer('classifier_max_p95_latency_ms'),
  auto_decider_min_cost_usd: real('auto_decider_min_cost_usd').notNull().default(15),
  auto_decider_max_cost_usd: real('auto_decider_max_cost_usd').notNull().default(25),
  updated_at: text('updated_at').notNull(),
  updated_by: text('updated_by'),
});

export const configClassifierModels = sqliteTable('config_classifier_models', {
  model: text('model').primaryKey(),
});

export const configDeciderModels = sqliteTable('config_decider_models', {
  model: text('model').primaryKey(),
  reasoning_effort: text('reasoning_effort'),
});

export const configAutoDeciderModels = sqliteTable('config_auto_decider_models', {
  model: text('model').primaryKey(),
  reasoning_effort: text('reasoning_effort'),
  avg_attempt_cost_usd: real('avg_attempt_cost_usd').notNull(),
  synced_at: text('synced_at').notNull(),
});

export const configAutoDeciderExclusions = sqliteTable('config_auto_decider_exclusions', {
  model: text('model').primaryKey(),
});

export const benchmarkRuns = sqliteTable(
  'benchmark_runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<BenchmarkKind>().notNull(),
    status: text('status').$type<BenchmarkRunStatus>().notNull(),
    started_at: text('started_at').notNull(),
    completed_at: text('completed_at'),
    error: text('error'),
    // Config snapshot taken at startRun time so mid-run edits can't skew results.
    min_accuracy: real('min_accuracy').notNull(),
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
    // At most one running run per (kind, purpose) — the atomic backstop for the
    // server-side admission rule (concurrent POSTs / multiple tabs that slip
    // past the pre-check still can't both claim). The platform and user queues
    // hold independent slots, so a user drain never blocks a platform run.
    uniqueIndex('UQ_benchmark_runs_one_running_per_kind_purpose')
      .on(table.kind, table.purpose)
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
    // Classifier diagnostics.
    fallback_reason: text('fallback_reason'),
    retried: integer('retried', { mode: 'boolean' }),
    // Decider diagnostics.
    exit_code: integer('exit_code'),
    output_prefix: text('output_prefix'),
    event_count: integer('event_count'),
    last_event_types: text('last_event_types'),
    // Repetition index (0-based); together with run_id/model/variant/case_id forms the PK.
    rep: integer('rep').notNull().default(0),
    // 1 when the case was killed by the wall-clock timeout, 0 otherwise.
    timed_out: integer('timed_out').notNull().default(0),
  },
  // The composite PK's leftmost column already serves run_id-prefix lookups
  // (count/fetch by run); no separate run_id index is needed.
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.variant, table.case_id, table.rep] }),
  ]
);

export const routingTables = sqliteTable('routing_tables', {
  run_id: text('run_id').primaryKey(),
  published_at: text('published_at').notNull(),
  generated_at: text('generated_at').notNull(),
  min_accuracy: real('min_accuracy').notNull(),
  switch_cost_factor: real('switch_cost_factor').notNull(),
  best_accuracy_switch_threshold: real('best_accuracy_switch_threshold').notNull().default(0.05),
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
    // Non-null unlike model_summaries: RankedCandidate.avgCostUsd is a plain
    // nonnegative number (buildRoutingTable excludes summaries without a
    // cost signal, so every published candidate has one).
    avg_cost_usd: real('avg_cost_usd').notNull(),
    meets_threshold: integer('meets_threshold', { mode: 'boolean' }).notNull(),
    // Legacy effort key; platform table JSON still reads this column.
    reasoning_effort: text('reasoning_effort'),
    // Exact-pair identity mirror ('' = null). Keeps rows self-describing; no PK change.
    variant: text('variant').notNull().default(''),
  },
  table => [primaryKey({ columns: [table.run_id, table.route_key, table.rank] })]
);

/**
 * Global Benchmark-profile registry: one current row per exact Pool entry per
 * engine identity + repetitions. Old-engine rows remain as history; currency
 * is decided by matching the live decider engine identity and repetitions.
 */
export const benchmarkProfiles = sqliteTable(
  'benchmark_profiles',
  {
    model: text('model').notNull(),
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
      columns: [table.model, table.variant, table.engine_identity, table.repetitions],
    }),
  ]
);

/**
 * Rolling owner admission ledger for the 24h profile request quota. One row
 * per charged admission (new under current engine, or explicit failed retry).
 * Stale engine-drift re-admissions are free and do not insert here.
 */
export const profileRequestEvents = sqliteTable(
  'profile_request_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner_type: text('owner_type').notNull(),
    owner_id: text('owner_id').notNull(),
    model: text('model').notNull(),
    variant: text('variant').notNull().default(''),
    engine_identity: text('engine_identity').notNull(),
    repetitions: integer('repetitions').notNull(),
    admitted_at: text('admitted_at').notNull(),
  },
  table => [
    // Lookup window: count an owner's admissions in the preceding 24 hours.
    index('IDX_profile_request_events_owner_admitted').on(
      table.owner_type,
      table.owner_id,
      table.admitted_at
    ),
  ]
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
