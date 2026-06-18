import type {
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkRun,
  ClassifierWinner,
  RankedCandidate,
  RoutingTable,
} from '@kilocode/auto-routing-contracts';
import type { BatchItem } from 'drizzle-orm/batch';
import { RoutingTableSchema } from '@kilocode/auto-routing-contracts';
import { and, count, desc, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  benchmarkConfig,
  benchmarkRuns,
  caseResults,
  configAutoDeciderExclusions,
  configAutoDeciderModels,
  configClassifierModels,
  configDeciderModels,
  modelSummaries,
  routingTableCandidates,
  routingTables,
  runModels,
} from './db-schema';
import { pickClassifierWinner } from './winner';
import { parsePersistedReasoningEffort } from './reasoning-effort';

export type CaseResultRow = typeof caseResults.$inferSelect;
export type RunRow = typeof benchmarkRuns.$inferSelect;
export type RunModelRow = typeof runModels.$inferSelect;
export type ConfigDeciderModelRow = typeof configDeciderModels.$inferSelect;
export type ConfigAutoDeciderModelRow = typeof configAutoDeciderModels.$inferSelect;
type ModelSummaryRow = typeof modelSummaries.$inferSelect;

// D1 rejects statements with too many bound variables. A model summary insert
// binds 12 values per row, so 8 rows keeps each INSERT below the 100-variable
// ceiling while still batching the delete plus inserts together.
const MODEL_SUMMARY_INSERT_BATCH_SIZE = 8;

// Routing table candidates bind 8 values per row. Keep each INSERT comfortably
// under D1's 100-variable ceiling; publishing is infrequent, so smaller
// statements are preferable to risking a skipped routing-table update.
const ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

export function mapSummaryRow(row: ModelSummaryRow): BenchmarkModelSummary {
  return {
    model: row.model,
    routeKey: row.route_key as BenchmarkModelSummary['routeKey'],
    accuracy: row.accuracy,
    avgCostUsd: row.avg_cost_usd,
    avgLatencyMs: row.avg_latency_ms,
    p50LatencyMs: row.p50_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    cases: row.cases,
    errors: row.errors,
    timeouts: row.timeouts,
  };
}

export function mapRunRow(row: RunRow, summaries: BenchmarkModelSummary[]): BenchmarkRun {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    summaries,
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getConfigRows(db: D1Database): Promise<{
  config: typeof benchmarkConfig.$inferSelect | null;
  classifierModels: string[];
  deciderModels: ConfigDeciderModelRow[];
  autoDeciderModels: ConfigAutoDeciderModelRow[];
  excludedAutoDeciderModels: string[];
}> {
  const orm = drizzle(db);
  const [configRows, classifierRows, deciderRows, autoDeciderRows, exclusionRows] =
    await Promise.all([
      orm.select().from(benchmarkConfig).where(eq(benchmarkConfig.id, 1)).limit(1),
      orm.select().from(configClassifierModels),
      orm.select().from(configDeciderModels),
      orm.select().from(configAutoDeciderModels),
      orm.select().from(configAutoDeciderExclusions),
    ]);
  return {
    config: configRows[0] ?? null,
    classifierModels: classifierRows.map(r => r.model),
    deciderModels: deciderRows,
    autoDeciderModels: autoDeciderRows,
    excludedAutoDeciderModels: exclusionRows.map(r => r.model),
  };
}

export async function replaceConfig(
  db: D1Database,
  config: {
    min_accuracy: number;
    switch_cost_factor: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    classifier_repetitions: number;
    decider_repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    auto_decider_min_cost_usd: number;
    auto_decider_max_cost_usd: number;
    updated_at: string;
    updated_by: string | null;
  },
  classifierModels: string[],
  deciderModels: ConfigDeciderModelRow[],
  excludedAutoDeciderModels: string[] = []
): Promise<void> {
  const orm = drizzle(db);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm
      .insert(benchmarkConfig)
      .values({ id: 1, ...config })
      .onConflictDoUpdate({
        target: benchmarkConfig.id,
        set: config,
      }),
    orm.delete(configClassifierModels),
    orm.delete(configDeciderModels),
    orm.delete(configAutoDeciderExclusions),
  ];
  if (classifierModels.length > 0) {
    stmts.push(
      orm.insert(configClassifierModels).values(classifierModels.map(m => ({ model: m })))
    );
  }
  if (deciderModels.length > 0) {
    stmts.push(orm.insert(configDeciderModels).values(deciderModels));
  }
  if (excludedAutoDeciderModels.length > 0) {
    stmts.push(
      orm
        .insert(configAutoDeciderExclusions)
        .values(excludedAutoDeciderModels.map(model => ({ model })))
    );
  }
  await orm.batch(stmts);
}

export async function replaceAutoDeciderModels(
  db: D1Database,
  autoDeciderModels: ConfigAutoDeciderModelRow[]
): Promise<void> {
  const orm = drizzle(db);
  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm.delete(configAutoDeciderModels),
  ];
  if (autoDeciderModels.length > 0) {
    stmts.push(orm.insert(configAutoDeciderModels).values(autoDeciderModels));
  }
  await orm.batch(stmts);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export async function insertRun(
  db: D1Database,
  run: {
    id: string;
    kind: BenchmarkKind;
    startedAt: string;
    min_accuracy: number;
    switch_cost_factor: number;
    max_concurrency: number;
    benchmark_user_id: string | null;
    benchmark_org_id: string | null;
    repetitions: number;
    classifier_max_p95_latency_ms: number | null;
    engine_identity: string;
  },
  models: RunModelRow[],
  carriedSummaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  const insertRunStmt = orm.insert(benchmarkRuns).values({
    id: run.id,
    kind: run.kind,
    status: 'running',
    started_at: run.startedAt,
    min_accuracy: run.min_accuracy,
    switch_cost_factor: run.switch_cost_factor,
    max_concurrency: run.max_concurrency,
    benchmark_user_id: run.benchmark_user_id,
    benchmark_org_id: run.benchmark_org_id,
    repetitions: run.repetitions,
    classifier_max_p95_latency_ms: run.classifier_max_p95_latency_ms,
    engine_identity: run.engine_identity,
  });

  if (models.length === 0 && carriedSummaries.length === 0) {
    await insertRunStmt;
    return;
  }

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [insertRunStmt];

  if (models.length > 0) {
    stmts.push(orm.insert(runModels).values(models));
  }

  for (let i = 0; i < carriedSummaries.length; i += MODEL_SUMMARY_INSERT_BATCH_SIZE) {
    const summaryChunk = carriedSummaries.slice(i, i + MODEL_SUMMARY_INSERT_BATCH_SIZE);
    stmts.push(
      orm.insert(modelSummaries).values(
        summaryChunk.map(s => ({
          run_id: run.id,
          model: s.model,
          route_key: s.routeKey,
          accuracy: s.accuracy,
          avg_cost_usd: s.avgCostUsd,
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          errors: s.errors,
          timeouts: s.timeouts,
          carried: true,
        }))
      )
    );
  }

  await orm.batch(stmts);
}

export async function getRunWithModels(
  db: D1Database,
  runId: string
): Promise<{ run: RunRow; models: RunModelRow[] } | null> {
  const orm = drizzle(db);
  const [run, models] = await Promise.all([
    orm.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, runId)).get(),
    orm.select().from(runModels).where(eq(runModels.run_id, runId)),
  ]);
  if (!run) return null;
  return { run, models };
}

// ---------------------------------------------------------------------------
// Case results
// ---------------------------------------------------------------------------

export async function upsertCaseResult(db: D1Database, row: CaseResultRow): Promise<void> {
  await drizzle(db)
    .insert(caseResults)
    .values(row)
    .onConflictDoUpdate({
      target: [caseResults.run_id, caseResults.model, caseResults.case_id, caseResults.rep],
      set: {
        route_key: row.route_key,
        score: row.score,
        latency_ms: row.latency_ms,
        cost_usd: row.cost_usd,
        error: row.error,
        fallback_reason: row.fallback_reason,
        retried: row.retried,
        exit_code: row.exit_code,
        output_prefix: row.output_prefix,
        event_count: row.event_count,
        last_event_types: row.last_event_types,
        rep: row.rep,
        timed_out: row.timed_out,
      },
    });
}

export async function countCaseResults(db: D1Database, runId: string): Promise<number> {
  const row = await drizzle(db)
    .select({ n: count() })
    .from(caseResults)
    .where(eq(caseResults.run_id, runId))
    .get();
  return row?.n ?? 0;
}

export async function getCaseResults(db: D1Database, runId: string): Promise<CaseResultRow[]> {
  return drizzle(db).select().from(caseResults).where(eq(caseResults.run_id, runId));
}

export async function getExistingCaseResultIds(
  db: D1Database,
  params: { runId: string; model: string; rep: number; caseIds: string[] }
): Promise<Set<string>> {
  if (params.caseIds.length === 0) return new Set();
  const rows = await drizzle(db)
    .select({ case_id: caseResults.case_id })
    .from(caseResults)
    .where(
      and(
        eq(caseResults.run_id, params.runId),
        eq(caseResults.model, params.model),
        eq(caseResults.rep, params.rep),
        inArray(caseResults.case_id, params.caseIds)
      )
    );
  return new Set(rows.map(row => row.case_id));
}

// ---------------------------------------------------------------------------
// Model summaries
// ---------------------------------------------------------------------------

export async function replaceModelSummaries(
  db: D1Database,
  runId: string,
  summaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  // Only delete non-carried rows; carried rows (from skipped models) stay.
  const deleteStmt = orm
    .delete(modelSummaries)
    .where(and(eq(modelSummaries.run_id, runId), eq(modelSummaries.carried, false)));

  if (summaries.length === 0) {
    await deleteStmt;
    return;
  }

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [deleteStmt];
  for (let i = 0; i < summaries.length; i += MODEL_SUMMARY_INSERT_BATCH_SIZE) {
    const summaryChunk = summaries.slice(i, i + MODEL_SUMMARY_INSERT_BATCH_SIZE);
    stmts.push(
      orm.insert(modelSummaries).values(
        summaryChunk.map(s => ({
          run_id: runId,
          model: s.model,
          route_key: s.routeKey,
          accuracy: s.accuracy,
          avg_cost_usd: s.avgCostUsd,
          avg_latency_ms: s.avgLatencyMs,
          p50_latency_ms: s.p50LatencyMs,
          p95_latency_ms: s.p95LatencyMs,
          cases: s.cases,
          errors: s.errors,
          timeouts: s.timeouts,
          carried: false,
        }))
      )
    );
  }
  await orm.batch(stmts);
}

export async function getSummaries(
  db: D1Database,
  runId: string
): Promise<BenchmarkModelSummary[]> {
  const rows = await drizzle(db)
    .select()
    .from(modelSummaries)
    .where(eq(modelSummaries.run_id, runId));
  return rows.map(mapSummaryRow);
}

export async function listRuns(db: D1Database, limit: number): Promise<BenchmarkRun[]> {
  const orm = drizzle(db);
  const runRows = await orm
    .select()
    .from(benchmarkRuns)
    .orderBy(desc(benchmarkRuns.started_at))
    .limit(limit);

  if (runRows.length === 0) {
    return [];
  }

  const summaryRows = await orm
    .select()
    .from(modelSummaries)
    .where(
      inArray(
        modelSummaries.run_id,
        runRows.map(r => r.id)
      )
    );

  const summariesByRunId = new Map<string, BenchmarkModelSummary[]>();
  for (const row of summaryRows) {
    const existing = summariesByRunId.get(row.run_id);
    if (existing) {
      existing.push(mapSummaryRow(row));
    } else {
      summariesByRunId.set(row.run_id, [mapSummaryRow(row)]);
    }
  }

  return runRows.map(row => mapRunRow(row, summariesByRunId.get(row.id) ?? []));
}

export async function markRunCompleted(db: D1Database, runId: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'completed', completed_at: new Date().toISOString() })
    .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'running')));
}

export async function markStaleRunsFailed(db: D1Database, olderThanIso: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'failed', error: 'timed out' })
    .where(and(eq(benchmarkRuns.status, 'running'), lt(benchmarkRuns.started_at, olderThanIso)));
}

// The currently-running run of a kind, if any (used for the one-active-run-per-kind
// admission pre-check). Stale runs are swept to 'failed' before this is consulted.
export async function getRunningRun(
  db: D1Database,
  kind: BenchmarkKind
): Promise<RunRow | undefined> {
  return drizzle(db)
    .select()
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.kind, kind), eq(benchmarkRuns.status, 'running')))
    .get();
}

// True when a run of the same kind started later than this one has already
// completed. Used to skip publishing so a slow older run can't overwrite a
// newer run's published routing table / classifier winner.
export async function existsNewerCompletedRun(
  db: D1Database,
  kind: BenchmarkKind,
  startedAt: string,
  runId: string
): Promise<boolean> {
  const newer = await drizzle(db)
    .select({ id: benchmarkRuns.id })
    .from(benchmarkRuns)
    .where(
      and(
        eq(benchmarkRuns.kind, kind),
        eq(benchmarkRuns.status, 'completed'),
        gt(benchmarkRuns.started_at, startedAt),
        ne(benchmarkRuns.id, runId)
      )
    )
    .get();
  return newer !== undefined;
}

export async function markRunFailed(db: D1Database, runId: string, error: string): Promise<void> {
  await drizzle(db)
    .update(benchmarkRuns)
    .set({ status: 'failed', error: error.slice(0, 500), completed_at: new Date().toISOString() })
    .where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, 'running')));
}

// ---------------------------------------------------------------------------
// Latest summaries per model (for skip logic and classifier winner)
// ---------------------------------------------------------------------------

// What the most recent completed run measured for a model, plus the
// benchmark identity it was measured under. startRun carries these summaries
// into a new run only when the identity (engine + repetitions + the model's
// reasoning_effort) still matches; otherwise the model is re-benchmarked.
export type PriorModelResult = {
  engineIdentity: string;
  repetitions: number;
  reasoningEffort: string | null;
  summaries: BenchmarkModelSummary[];
};

// Latest summaries per model for a benchmark kind: for each model, all routes
// from the most recent COMPLETED run that included it (mixing routes across
// runs would pair incomparable numbers).
export async function getLatestSummariesByModel(
  db: D1Database,
  kind: BenchmarkKind
): Promise<Map<string, PriorModelResult>> {
  const results = await drizzle(db)
    .select({
      run_id: modelSummaries.run_id,
      model: modelSummaries.model,
      route_key: modelSummaries.route_key,
      accuracy: modelSummaries.accuracy,
      avg_cost_usd: modelSummaries.avg_cost_usd,
      avg_latency_ms: modelSummaries.avg_latency_ms,
      p50_latency_ms: modelSummaries.p50_latency_ms,
      p95_latency_ms: modelSummaries.p95_latency_ms,
      cases: modelSummaries.cases,
      errors: modelSummaries.errors,
      timeouts: modelSummaries.timeouts,
      carried: modelSummaries.carried,
      engine_identity: benchmarkRuns.engine_identity,
      repetitions: benchmarkRuns.repetitions,
      reasoning_effort: runModels.reasoning_effort,
    })
    .from(modelSummaries)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, modelSummaries.run_id))
    .leftJoin(
      runModels,
      and(eq(runModels.run_id, modelSummaries.run_id), eq(runModels.model, modelSummaries.model))
    )
    .where(and(eq(benchmarkRuns.kind, kind), eq(benchmarkRuns.status, 'completed')))
    .orderBy(desc(benchmarkRuns.started_at));

  const latestRunByModel = new Map<string, string>();
  for (const row of results) {
    if (!latestRunByModel.has(row.model)) latestRunByModel.set(row.model, row.run_id);
  }
  const byModel = new Map<string, PriorModelResult>();
  for (const row of results) {
    if (latestRunByModel.get(row.model) !== row.run_id) continue;
    const existing = byModel.get(row.model);
    if (existing) {
      existing.summaries.push(mapSummaryRow(row));
    } else {
      byModel.set(row.model, {
        engineIdentity: row.engine_identity,
        repetitions: row.repetitions,
        reasoningEffort: row.reasoning_effort,
        summaries: [mapSummaryRow(row)],
      });
    }
  }
  return byModel;
}

// ---------------------------------------------------------------------------
// Routing table — pure helpers for explode/reassemble
// ---------------------------------------------------------------------------

type RoutingTableRow = typeof routingTables.$inferSelect;
type RoutingTableCandidateRow = typeof routingTableCandidates.$inferSelect;

export function routingTableToRows(
  table: RoutingTable,
  publishedAt: string
): { tableRow: RoutingTableRow; candidateRows: RoutingTableCandidateRow[] } {
  const tableRow: RoutingTableRow = {
    run_id: table.version,
    published_at: publishedAt,
    generated_at: table.generatedAt,
    min_accuracy: table.minAccuracy,
    switch_cost_factor: table.switchCostFactor,
    source: table.source,
  };

  const candidateRows: RoutingTableCandidateRow[] = [];
  for (const [routeKey, candidates] of Object.entries(table.routes)) {
    candidates.forEach((c, rank) => {
      candidateRows.push({
        run_id: table.version,
        route_key: routeKey,
        rank,
        model: c.model,
        accuracy: c.accuracy,
        avg_cost_usd: c.avgCostUsd,
        meets_threshold: c.meetsThreshold,
        reasoning_effort: c.reasoningEffort ?? null,
      });
    });
  }

  return { tableRow, candidateRows };
}

export function rowsToRoutingTable(
  tableRow: RoutingTableRow,
  candidateRows: RoutingTableCandidateRow[]
): RoutingTable {
  const routeMap: Record<string, RankedCandidate[]> = {};
  const sorted = [...candidateRows].sort((a, b) => {
    if (a.route_key !== b.route_key) return a.route_key.localeCompare(b.route_key);
    return a.rank - b.rank;
  });
  for (const row of sorted) {
    routeMap[row.route_key] ??= [];
    routeMap[row.route_key].push({
      model: row.model,
      accuracy: row.accuracy,
      avgCostUsd: row.avg_cost_usd,
      meetsThreshold: row.meets_threshold,
      reasoningEffort: parsePersistedReasoningEffort(row.reasoning_effort),
    });
  }
  return {
    version: tableRow.run_id,
    generatedAt: tableRow.generated_at,
    minAccuracy: tableRow.min_accuracy,
    switchCostFactor: tableRow.switch_cost_factor,
    source: tableRow.source as RoutingTable['source'],
    routes: routeMap,
  };
}

export async function saveRoutingTable(
  db: D1Database,
  table: RoutingTable,
  publishedAt: string
): Promise<void> {
  const orm = drizzle(db);
  const { tableRow, candidateRows } = routingTableToRows(table, publishedAt);

  const stmts: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = [
    orm.delete(routingTableCandidates).where(eq(routingTableCandidates.run_id, table.version)),
    orm
      .insert(routingTables)
      .values(tableRow)
      .onConflictDoUpdate({
        target: routingTables.run_id,
        set: {
          published_at: tableRow.published_at,
          generated_at: tableRow.generated_at,
          min_accuracy: tableRow.min_accuracy,
          switch_cost_factor: tableRow.switch_cost_factor,
          source: tableRow.source,
        },
      }),
  ];

  for (let i = 0; i < candidateRows.length; i += ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE) {
    stmts.push(
      orm
        .insert(routingTableCandidates)
        .values(candidateRows.slice(i, i + ROUTING_TABLE_CANDIDATE_INSERT_BATCH_SIZE))
    );
  }

  await orm.batch(stmts);
}

export async function getLatestRoutingTable(
  db: D1Database
): Promise<{ table: RoutingTable; publishedAt: string } | null> {
  const orm = drizzle(db);
  const tableRow = await orm
    .select()
    .from(routingTables)
    .orderBy(desc(routingTables.published_at))
    .limit(1)
    .get();

  if (!tableRow) return null;

  const candidateRows = await orm
    .select()
    .from(routingTableCandidates)
    .where(eq(routingTableCandidates.run_id, tableRow.run_id))
    .orderBy(routingTableCandidates.route_key, routingTableCandidates.rank);

  const assembled = rowsToRoutingTable(tableRow, candidateRows);
  const parsed = RoutingTableSchema.safeParse(assembled);
  if (!parsed.success) {
    console.warn(
      JSON.stringify({
        event: 'routing_table_invalid',
        run_id: tableRow.run_id,
        error: parsed.error.message,
      })
    );
    return null;
  }

  return { table: parsed.data, publishedAt: tableRow.published_at };
}

// ---------------------------------------------------------------------------
// Classifier winner
// ---------------------------------------------------------------------------

export async function getClassifierWinner(db: D1Database): Promise<ClassifierWinner | null> {
  const orm = drizzle(db);
  // Find the latest completed classifier run.
  const runRow = await orm
    .select()
    .from(benchmarkRuns)
    .where(and(eq(benchmarkRuns.kind, 'classifier'), eq(benchmarkRuns.status, 'completed')))
    .orderBy(desc(benchmarkRuns.completed_at))
    .limit(1)
    .get();

  if (!runRow) return null;

  // Get the routeKey='*' summaries for this run (classifier has no taxonomy route).
  const summaryRows = await orm
    .select()
    .from(modelSummaries)
    .where(and(eq(modelSummaries.run_id, runRow.id), eq(modelSummaries.route_key, '*')));

  const summaries = summaryRows.map(mapSummaryRow);
  const winner = pickClassifierWinner(
    summaries,
    runRow.min_accuracy,
    runRow.classifier_max_p95_latency_ms
  );
  if (!winner) return null;

  return {
    model: winner.model,
    runId: runRow.id,
    accuracy: winner.accuracy,
    p95LatencyMs: winner.p95LatencyMs,
    generatedAt: runRow.completed_at ?? new Date().toISOString(),
  };
}
