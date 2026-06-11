import type {
  BenchmarkKind,
  BenchmarkModelSummary,
  BenchmarkRun,
} from '@kilocode/auto-routing-contracts';

export type CaseResultRow = {
  run_id: string;
  model: string;
  case_id: string;
  tier: string | null;
  score: number;
  latency_ms: number;
  cost_usd: number | null;
  detail_json: string | null;
  error: string | null;
};

export type RunRow = {
  id: string;
  kind: BenchmarkKind;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  config_json: string;
  error: string | null;
};

type ModelSummaryRow = {
  run_id: string;
  model: string;
  tier: string;
  accuracy: number;
  avg_cost_usd: number | null;
  avg_latency_ms: number;
  p50_latency_ms: number | null;
  cases: number;
  errors: number;
};

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
  run: { id: string; kind: BenchmarkKind; startedAt: string; configJson: string }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO benchmark_runs (id, kind, status, started_at, config_json)
       VALUES (?1, ?2, 'running', ?3, ?4)`
    )
    .bind(run.id, run.kind, run.startedAt, run.configJson)
    .run();
}

export async function getRun(db: D1Database, runId: string): Promise<RunRow | null> {
  const row = await db
    .prepare('SELECT * FROM benchmark_runs WHERE id = ?1')
    .bind(runId)
    .first<RunRow>();
  return row ?? null;
}

export async function upsertCaseResult(db: D1Database, row: CaseResultRow): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO case_results
       (run_id, model, case_id, tier, score, latency_ms, cost_usd, detail_json, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      row.run_id,
      row.model,
      row.case_id,
      row.tier,
      row.score,
      row.latency_ms,
      row.cost_usd,
      row.detail_json,
      row.error
    )
    .run();
}

export async function countCaseResults(db: D1Database, runId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM case_results WHERE run_id = ?1')
    .bind(runId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getCaseResults(db: D1Database, runId: string): Promise<CaseResultRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM case_results WHERE run_id = ?1')
    .bind(runId)
    .all<CaseResultRow>();
  return results;
}

export async function replaceModelSummaries(
  db: D1Database,
  runId: string,
  summaries: BenchmarkModelSummary[]
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM model_summaries WHERE run_id = ?1').bind(runId),
    ...summaries.map(s =>
      db
        .prepare(
          `INSERT INTO model_summaries
           (run_id, model, tier, accuracy, avg_cost_usd, avg_latency_ms, p50_latency_ms, cases, errors)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          runId,
          s.model,
          s.tier,
          s.accuracy,
          s.avgCostUsd,
          s.avgLatencyMs,
          s.p50LatencyMs,
          s.cases,
          s.errors
        )
    ),
  ];
  await db.batch(statements);
}

export async function getSummaries(
  db: D1Database,
  runId: string
): Promise<BenchmarkModelSummary[]> {
  const { results } = await db
    .prepare('SELECT * FROM model_summaries WHERE run_id = ?1')
    .bind(runId)
    .all<ModelSummaryRow>();
  return results.map(mapSummaryRow);
}

export async function listRuns(db: D1Database, limit: number): Promise<BenchmarkRun[]> {
  const { results: runRows } = await db
    .prepare('SELECT * FROM benchmark_runs ORDER BY started_at DESC LIMIT ?1')
    .bind(limit)
    .all<RunRow>();

  if (runRows.length === 0) {
    return [];
  }

  const placeholders = runRows.map((_, i) => `?${i + 1}`).join(', ');
  const { results: summaryRows } = await db
    .prepare(`SELECT * FROM model_summaries WHERE run_id IN (${placeholders})`)
    .bind(...runRows.map(r => r.id))
    .all<ModelSummaryRow>();

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
  await db
    .prepare(
      `UPDATE benchmark_runs SET status = 'completed', completed_at = ?2
       WHERE id = ?1 AND status = 'running'`
    )
    .bind(runId, new Date().toISOString())
    .run();
}

export async function markStaleRunsFailed(
  db: D1Database,
  olderThanIso: string
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE benchmark_runs SET status = 'failed', error = 'timed out'
       WHERE status = 'running' AND started_at < ?1`
    )
    .bind(olderThanIso)
    .run();
  return result.meta.changes;
}

export async function saveRoutingTable(
  db: D1Database,
  runId: string,
  publishedAt: string,
  tableJson: string
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO routing_tables (run_id, published_at, table_json)
       VALUES (?1, ?2, ?3)`
    )
    .bind(runId, publishedAt, tableJson)
    .run();
}

export async function getLatestRoutingTable(
  db: D1Database
): Promise<{ run_id: string; published_at: string; table_json: string } | null> {
  const row = await db
    .prepare('SELECT * FROM routing_tables ORDER BY published_at DESC LIMIT 1')
    .first<{ run_id: string; published_at: string; table_json: string }>();
  return row ?? null;
}

export async function getConfigRow(
  db: D1Database
): Promise<{ config_json: string; updated_at: string; updated_by: string | null } | null> {
  const row = await db
    .prepare('SELECT config_json, updated_at, updated_by FROM benchmark_config WHERE id = 1')
    .first<{ config_json: string; updated_at: string; updated_by: string | null }>();
  return row ?? null;
}

export async function saveConfigRow(
  db: D1Database,
  configJson: string,
  updatedAt: string,
  updatedBy: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO benchmark_config (id, config_json, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3)`
    )
    .bind(configJson, updatedAt, updatedBy)
    .run();
}
