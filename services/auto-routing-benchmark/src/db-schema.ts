import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BenchmarkKind, BenchmarkRunStatus } from '@kilocode/auto-routing-contracts';

// Migrations are generated via `pnpm db:generate` (drizzle-kit) and applied
// via wrangler d1 migrations apply.

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  min_accuracy: real('min_accuracy').notNull(),
  max_concurrency: integer('max_concurrency').notNull(),
  benchmark_user_id: text('benchmark_user_id'),
  updated_at: text('updated_at').notNull(),
  updated_by: text('updated_by'),
});

export const configClassifierModels = sqliteTable('config_classifier_models', {
  model: text('model').primaryKey(),
});

export const configDeciderModels = sqliteTable('config_decider_models', {
  model: text('model').primaryKey(),
  reasoning_effort: text('reasoning_effort'),
  supports_chat_completions: integer('supports_chat_completions', { mode: 'boolean' }).notNull(),
  supports_messages: integer('supports_messages', { mode: 'boolean' }).notNull(),
  supports_responses: integer('supports_responses', { mode: 'boolean' }).notNull(),
});

export const benchmarkRuns = sqliteTable('benchmark_runs', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<BenchmarkKind>().notNull(),
  status: text('status').$type<BenchmarkRunStatus>().notNull(),
  started_at: text('started_at').notNull(),
  completed_at: text('completed_at'),
  error: text('error'),
  // Config snapshot taken at startRun time so mid-run edits can't skew results.
  min_accuracy: real('min_accuracy').notNull(),
  max_concurrency: integer('max_concurrency').notNull(),
  benchmark_user_id: text('benchmark_user_id'),
});

export const runModels = sqliteTable(
  'run_models',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    // enqueued=false means the model was skipped (had prior results).
    enqueued: integer('enqueued', { mode: 'boolean' }).notNull(),
    reasoning_effort: text('reasoning_effort'),
    supports_chat_completions: integer('supports_chat_completions', { mode: 'boolean' }).notNull(),
    supports_messages: integer('supports_messages', { mode: 'boolean' }).notNull(),
    supports_responses: integer('supports_responses', { mode: 'boolean' }).notNull(),
  },
  table => [primaryKey({ columns: [table.run_id, table.model] })]
);

export const modelSummaries = sqliteTable(
  'model_summaries',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    tier: text('tier').notNull(),
    accuracy: real('accuracy').notNull(),
    avg_cost_usd: real('avg_cost_usd'),
    avg_latency_ms: real('avg_latency_ms').notNull(),
    p50_latency_ms: real('p50_latency_ms'),
    cases: integer('cases').notNull(),
    errors: integer('errors').notNull(),
    // carried=true rows are prior-run summaries copied in at startRun for skipped models.
    carried: integer('carried', { mode: 'boolean' }).notNull().default(false),
  },
  table => [primaryKey({ columns: [table.run_id, table.model, table.tier] })]
);

export const caseResults = sqliteTable(
  'case_results',
  {
    run_id: text('run_id').notNull(),
    model: text('model').notNull(),
    case_id: text('case_id').notNull(),
    tier: text('tier'),
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
  },
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.case_id] }),
    index('idx_case_results_run').on(table.run_id),
  ]
);

export const routingTables = sqliteTable('routing_tables', {
  run_id: text('run_id').primaryKey(),
  published_at: text('published_at').notNull(),
  generated_at: text('generated_at').notNull(),
  min_accuracy: real('min_accuracy').notNull(),
  source: text('source').notNull(),
});

export const routingTableCandidates = sqliteTable(
  'routing_table_candidates',
  {
    run_id: text('run_id').notNull(),
    tier: text('tier').notNull(),
    rank: integer('rank').notNull(),
    model: text('model').notNull(),
    accuracy: real('accuracy').notNull(),
    // Non-null unlike model_summaries: RankedCandidate.avgCostUsd is a plain
    // nonnegative number (buildRoutingTable excludes summaries without a
    // cost signal, so every published candidate has one).
    avg_cost_usd: real('avg_cost_usd').notNull(),
    meets_threshold: integer('meets_threshold', { mode: 'boolean' }).notNull(),
    reasoning_effort: text('reasoning_effort'),
    supports_chat_completions: integer('supports_chat_completions', { mode: 'boolean' }).notNull(),
    supports_messages: integer('supports_messages', { mode: 'boolean' }).notNull(),
    supports_responses: integer('supports_responses', { mode: 'boolean' }).notNull(),
  },
  table => [primaryKey({ columns: [table.run_id, table.tier, table.rank] })]
);
