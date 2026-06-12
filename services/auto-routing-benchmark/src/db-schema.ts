import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BenchmarkKind } from '@kilocode/auto-routing-contracts';

// Mirrors migrations/*.sql (the source of truth, applied via wrangler). Keep
// the two in sync when adding columns.

export const benchmarkRuns = sqliteTable('benchmark_runs', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<BenchmarkKind>().notNull(),
  status: text('status').$type<'running' | 'completed' | 'failed'>().notNull(),
  started_at: text('started_at').notNull(),
  completed_at: text('completed_at'),
  config_json: text('config_json').notNull(),
  // Run-scoped execution state: which models were actually enqueued and the
  // summaries carried forward for models skipped because they already had
  // results. Null on rows created before the column existed.
  runtime_json: text('runtime_json'),
  error: text('error'),
});

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
    detail_json: text('detail_json'),
    error: text('error'),
  },
  table => [
    primaryKey({ columns: [table.run_id, table.model, table.case_id] }),
    index('idx_case_results_run').on(table.run_id),
  ]
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
  },
  table => [primaryKey({ columns: [table.run_id, table.model, table.tier] })]
);

export const routingTables = sqliteTable('routing_tables', {
  run_id: text('run_id').primaryKey(),
  published_at: text('published_at').notNull(),
  table_json: text('table_json').notNull(),
});

export const benchmarkConfig = sqliteTable('benchmark_config', {
  id: integer('id').primaryKey(),
  config_json: text('config_json').notNull(),
  updated_at: text('updated_at').notNull(),
  updated_by: text('updated_by'),
});
