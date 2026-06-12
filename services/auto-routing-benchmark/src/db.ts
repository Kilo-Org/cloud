import type {
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkRun,
} from '@kilocode/auto-routing-contracts';
import { and, count, desc, eq, inArray, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  benchmarkConfig,
  benchmarkRuns,
  caseResults,
  modelSummaries,
  routingTables,
} from './db-schema';

export type CaseResultRow = typeof caseResults.$inferSelect;
export type RunRow = typeof benchmarkRuns.$inferSelect;
type ModelSummaryRow = typeof modelSummaries.$inferSelect;

export function mapSummaryRow(row: ModelSummaryRow): BenchmarkModelSummary {
  return {
    model: row.model,
    tier: row.tier as BenchmarkModelSummary['tier'],
    accuracy: row.accuracy,
    avgCostUsd: row.avg_cost_usd,
    avgLatencyMs: row.avg_latency_ms,
    p50LatencyMs: row.p50_latency_ms,
    cases: row.cases,
    errors: row.errors,
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

export async function insertRun(
  db: D1Database,
  run: {
    id: string;
    kind: BenchmarkKind;
    startedAt: string;
    configJson: string;
    runtimeJson: string;
  }
): Promise<void> {
  await drizzle(db).insert(benchmarkRuns).values({
    id: run.id,
    kind: run.kind,
    status: 'running',
    started_at: run.startedAt,
    config_json: run.configJson,
    runtime_json: run.runtimeJson,
  });
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  const row = await drizzle(db)
    .select()
    .from(benchmarkRuns)
    .where(eq(benchmarkRuns.id, runId))
    .get();
  return row ?? null;
}

export async function upsertCaseResult(db: D1Database, row: CaseResultRow): Promise<void> {
  await drizzle(db)
    .insert(caseResults)
    .values(row)
    .onConflictDoUpdate({
      target: [caseResults.run_id, caseResults.model, caseResults.case_id],
      set: {
        tier: row.tier,
        score: row.score,
        latency_ms: row.latency_ms,
        cost_usd: row.cost_usd,
        detail_json: row.detail_json,
        error: row.error,
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

export async function replaceModelSummaries(
  db: D1Database,
  runId: string,
  summaries: BenchmarkModelSummary[]
): Promise<void> {
  const orm = drizzle(db);
  const deleteExisting = orm.delete(modelSummaries).where(eq(modelSummaries.run_id, runId));
  if (summaries.length === 0) {
    await deleteExisting;
    return;
  }
  await orm.batch([
    deleteExisting,
    orm.insert(modelSummaries).values(
      summaries.map(s => ({
        run_id: runId,
        model: s.model,
        tier: s.tier,
        accuracy: s.accuracy,
        avg_cost_usd: s.avgCostUsd,
        avg_latency_ms: s.avgLatencyMs,
        p50_latency_ms: s.p50LatencyMs,
        cases: s.cases,
        errors: s.errors,
      }))
    ),
  ]);
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

export async function saveRoutingTable(
  db: D1Database,
  runId: string,
  publishedAt: string,
  tableJson: string
): Promise<void> {
  await drizzle(db)
    .insert(routingTables)
    .values({ run_id: runId, published_at: publishedAt, table_json: tableJson })
    .onConflictDoUpdate({
      target: routingTables.run_id,
      set: { published_at: publishedAt, table_json: tableJson },
    });
}

export async function getLatestRoutingTable(
  db: D1Database
): Promise<typeof routingTables.$inferSelect | null> {
  const row = await drizzle(db)
    .select()
    .from(routingTables)
    .orderBy(desc(routingTables.published_at))
    .limit(1)
    .get();
  return row ?? null;
}

export async function getConfigRow(
  db: D1Database
): Promise<Omit<typeof benchmarkConfig.$inferSelect, 'id'> | null> {
  const row = await drizzle(db)
    .select({
      config_json: benchmarkConfig.config_json,
      updated_at: benchmarkConfig.updated_at,
      updated_by: benchmarkConfig.updated_by,
    })
    .from(benchmarkConfig)
    .where(eq(benchmarkConfig.id, 1))
    .get();
  return row ?? null;
}

export async function saveConfigRow(
  db: D1Database,
  configJson: string,
  updatedAt: string,
  updatedBy: string | null
): Promise<void> {
  await drizzle(db)
    .insert(benchmarkConfig)
    .values({ id: 1, config_json: configJson, updated_at: updatedAt, updated_by: updatedBy })
    .onConflictDoUpdate({
      target: benchmarkConfig.id,
      set: { config_json: configJson, updated_at: updatedAt, updated_by: updatedBy },
    });
}

// Latest summaries per model for a benchmark kind: for each model, all tiers
// from the most recent COMPLETED run that included it (mixing tiers across
// runs would pair incomparable numbers).
export async function getLatestSummariesByModel(
  db: D1Database,
  kind: BenchmarkKind
): Promise<Map<string, BenchmarkModelSummary[]>> {
  const results = await drizzle(db)
    .select({
      run_id: modelSummaries.run_id,
      model: modelSummaries.model,
      tier: modelSummaries.tier,
      accuracy: modelSummaries.accuracy,
      avg_cost_usd: modelSummaries.avg_cost_usd,
      avg_latency_ms: modelSummaries.avg_latency_ms,
      p50_latency_ms: modelSummaries.p50_latency_ms,
      cases: modelSummaries.cases,
      errors: modelSummaries.errors,
    })
    .from(modelSummaries)
    .innerJoin(benchmarkRuns, eq(benchmarkRuns.id, modelSummaries.run_id))
    .where(and(eq(benchmarkRuns.kind, kind), eq(benchmarkRuns.status, 'completed')))
    .orderBy(desc(benchmarkRuns.started_at));

  const latestRunByModel = new Map<string, string>();
  for (const row of results) {
    if (!latestRunByModel.has(row.model)) latestRunByModel.set(row.model, row.run_id);
  }
  const byModel = new Map<string, BenchmarkModelSummary[]>();
  for (const row of results) {
    if (latestRunByModel.get(row.model) !== row.run_id) continue;
    const list = byModel.get(row.model) ?? [];
    list.push(mapSummaryRow(row));
    byModel.set(row.model, list);
  }
  return byModel;
}
