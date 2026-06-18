import { sql } from 'drizzle-orm';
import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { BenchmarkKind, BenchmarkRunStatus } from '@kilocode/auto-routing-contracts';

// Migrations are generated via `pnpm db:generate` (drizzle-kit) and applied
// via wrangler d1 migrations apply.

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  min_accuracy: real('min_accuracy').notNull(),
  switch_cost_factor: real('switch_cost_factor').notNull(),
  max_concurrency: integer('max_concurrency').notNull(),
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
  },
  table => [
    // At most one running run per kind — the atomic backstop for the
    // server-side "one active run per kind" admission rule (concurrent POSTs /
    // multiple tabs that slip past the pre-check still can't both claim).
    uniqueIndex('UQ_benchmark_runs_one_running_per_kind')
      .on(table.kind)
      .where(sql`${table.status} = 'running'`),
  ]
);

export const runModels = sqliteTable(
  'run_models',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // enqueued=false means the model was skipped (had prior results).
    enqueued: integer('enqueued', { mode: 'boolean' }).notNull(),
    reasoning_effort: text('reasoning_effort'),
  },
  table => [primaryKey({ columns: [table.run_id, table.model] })]
);

export const modelSummaries = sqliteTable(
  'model_summaries',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
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
  table => [primaryKey({ columns: [table.run_id, table.model, table.route_key] })]
);

export const caseResults = sqliteTable(
  'case_results',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
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
    // Repetition index (0-based); together with run_id/model/case_id forms the PK.
    rep: integer('rep').notNull().default(0),
    // 1 when the case was killed by the wall-clock timeout, 0 otherwise.
    timed_out: integer('timed_out').notNull().default(0),
  },
  // The composite PK's leftmost column already serves run_id-prefix lookups
  // (count/fetch by run); no separate run_id index is needed.
  table => [primaryKey({ columns: [table.run_id, table.model, table.case_id, table.rep] })]
);

export const routingTables = sqliteTable('routing_tables', {
  run_id: text('run_id').primaryKey(),
  published_at: text('published_at').notNull(),
  generated_at: text('generated_at').notNull(),
  min_accuracy: real('min_accuracy').notNull(),
  switch_cost_factor: real('switch_cost_factor').notNull(),
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
    reasoning_effort: text('reasoning_effort'),
  },
  table => [primaryKey({ columns: [table.run_id, table.route_key, table.rank] })]
);
