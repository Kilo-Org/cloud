/**
 * Real SQLite execution of the admin run-totals aggregates. Intentionally does
 * NOT mock drizzle: the admin run list is a per-page page of up to 20 runs, so
 * each statement must reach case_results by its run_id index rather than scan
 * the table, and the cost columns must keep an unknown cost null rather than
 * turning it into a free (0) case.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import {
  listRunModelIds,
  listRunModelTotals,
  listRunModelTotalsStatement,
  listRunTotals,
  listRunTotalsStatement,
} from './db';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { variantFromStorage } from './reasoning-effort';

let sqlite: DatabaseSync;
let db: D1Database;

function plan(sql: string): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map(row => row.detail)
    .join('\n');
}

function insertRun(id: string, { router = 'efficient', kind = 'decider' } = {}) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at,
        min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity
      ) VALUES (?, ?, ?, 'platform', 'completed', '2026-11-01T00:00:00.000Z', 0.7, 3, 0, 1, 'v1:abc')`
    )
    .run(id, router, kind);
}

function insertCase(
  runId: string,
  {
    model = 'vendor/model',
    variant = '',
    caseId = 'case-1',
    score = 1,
    cost,
    error = null,
    timedOut = 0,
    routeHit = null,
  }: {
    model?: string;
    variant?: string;
    caseId?: string;
    score?: number;
    cost: number | null;
    error?: string | null;
    timedOut?: number;
    routeHit?: 0 | 1 | null;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO case_results (
        run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd,
        error, route_hit, rep, timed_out, exit_code, prompt_revision
      ) VALUES (?, ?, ?, ?, 'debugging/bug_fixing', ?, 10, ?, ?, ?, 0, ?, 0, 2)`
    )
    .run(runId, model, variant, caseId, score, cost, error, routeHit, timedOut);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  db = sqliteD1(sqlite);
});

describe('admin run totals', () => {
  it('seeks case_results by run_id for the whole page instead of scanning it', () => {
    const totals = listRunTotalsStatement(drizzle(db), ['run-a', 'run-b']).toSQL();
    const totalsPlan = plan(totals.sql);
    // One index seek on the composite primary key's leftmost column serves it.
    expect(totalsPlan).toContain('SEARCH case_results USING INDEX');
    expect(totalsPlan).toContain('run_id=?');
    expect(totalsPlan).not.toMatch(/^SCAN case_results\b/m);
    expect(totalsPlan).not.toMatch(/TEMP B-TREE/);

    const modelTotals = listRunModelTotalsStatement(drizzle(db), 'run-a').toSQL();
    const modelPlan = plan(modelTotals.sql);
    expect(modelPlan).toContain('SEARCH case_results USING INDEX');
    expect(modelPlan).not.toMatch(/^SCAN case_results\b/m);
  });

  it('sums cost and counts measured and errored cases per run, keeping an unknown cost null', async () => {
    insertRun('run-a');
    insertRun('run-b');
    insertRun('run-empty');
    // run-a: two costed cases (one errored), one case with no reported cost.
    insertCase('run-a', { caseId: 'a1', cost: 0.05 });
    insertCase('run-a', { caseId: 'a2', cost: 0.15, error: 'provider 503' });
    insertCase('run-a', { caseId: 'a3', cost: null });
    // run-b: every case timed out and none reported a cost.
    insertCase('run-b', { caseId: 'b1', cost: null, timedOut: 1 });
    insertCase('run-b', { caseId: 'b2', cost: null, timedOut: 1 });

    const totals = new Map(
      (await listRunTotals(db, ['run-a', 'run-b', 'run-empty'])).map(row => [row.runId, row])
    );

    expect(totals.get('run-a')).toEqual({
      runId: 'run-a',
      totalCostUsd: 0.2,
      measuredCases: 3,
      erroredCases: 1,
    });
    // SUM over only-null costs is null: the run's cost is unknown, not zero.
    expect(totals.get('run-b')).toEqual({
      runId: 'run-b',
      totalCostUsd: null,
      measuredCases: 2,
      erroredCases: 2,
    });
    expect(totals.has('run-empty')).toBe(false);
  });

  it('costs a still-running run from the cases it has measured so far', async () => {
    insertRun('run-running');
    sqlite
      .prepare(
        "UPDATE benchmark_runs SET status = 'running', completed_at = NULL WHERE id = 'run-running'"
      )
      .run();
    insertCase('run-running', { caseId: 'c1', cost: 0.04 });
    insertCase('run-running', { caseId: 'c2', cost: 0.06 });

    const [totals] = await listRunTotals(db, ['run-running']);

    expect(totals).toMatchObject({ totalCostUsd: 0.1, measuredCases: 2 });
  });

  it('lists the enqueued model ids per run and skips a not-enqueued (skipped) one', async () => {
    insertRun('run-a');
    insertRun('run-b');
    const insertModel = sqlite.prepare(
      `INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', ?)`
    );
    insertModel.run('run-a', 'vendor/alpha', 1);
    insertModel.run('run-a', 'vendor/beta', 1);
    // A skipped model was measured by an earlier run; it is not this run's work.
    insertModel.run('run-a', 'vendor/old', 0);

    const models = await listRunModelIds(db, ['run-a', 'run-b']);

    expect(models.get('run-a')).toEqual(['vendor/alpha', 'vendor/beta']);
    expect(models.has('run-b')).toBe(false);
  });

  it('reports per-pair accuracy and cost means from real case rows', async () => {
    insertRun('run-a');
    insertCase('run-a', {
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'a1',
      score: 1,
      cost: 0.02,
      routeHit: 1,
    });
    insertCase('run-a', {
      model: 'vendor/alpha',
      variant: 'high',
      caseId: 'a2',
      score: 0.5,
      cost: 0.06,
      routeHit: 0,
    });
    // No cost reported: excluded from the cost mean, still a measured case.
    insertCase('run-a', {
      model: 'vendor/beta',
      variant: '',
      caseId: 'b1',
      score: 1,
      cost: null,
    });

    const totals = await listRunModelTotals(db, 'run-a');

    // Ordered by case count then model here; the caller sorts for display.
    const alpha = totals.find(t => t.model === 'vendor/alpha');
    expect(alpha).toMatchObject({
      variant: 'high',
      cases: 2,
      costedCases: 2,
      routeGraded: 2,
      routeHits: 1,
    });
    expect(variantFromStorage(alpha?.variant ?? '')).toBe('high');
    const beta = totals.find(t => t.model === 'vendor/beta');
    expect(beta).toMatchObject({ costedCases: 0, costSum: null, cases: 1 });
  });
});
