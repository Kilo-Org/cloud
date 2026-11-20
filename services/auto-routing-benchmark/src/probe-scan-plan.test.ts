import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeCaseCountStatement } from './db';
import { applyBenchmarkMigrations } from '../test/sqlite-d1';

/**
 * The probe-eligibility count must seek the exact pair, not the pair's run.
 *
 * `case_results` is keyed `(run_id, model, variant, case_id, rep)`; a statement that names
 * only `run_id` uses that prefix and then reads every model's, every case's and every
 * repetition's row of that run. This pins the plan, because the row count is what decides
 * whether the worker's busiest admin read fits a single D1 resource window.
 */
describe('probe case count plan (production migrations)', () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
  });

  afterEach(() => sqlite.close());

  function plan(sql: string) {
    return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map(row => row.detail)
      .join('\n');
  }

  it('seeks each named pair on the full composite primary key', () => {
    const statementPlan = plan(probeCaseCountStatement(2));
    expect(statementPlan).toContain(
      'SEARCH measured USING INDEX sqlite_autoindex_case_results_1 (run_id=? AND model=? AND variant=? AND case_id=?)'
    );
    expect(statementPlan).not.toMatch(/^SEARCH measured USING INDEX sqlite_autoindex_case_results_1 \(run_id=\?\)/m);
    expect(statementPlan).not.toMatch(/^SCAN measured\b/m);
  });

  it('reads only the named pairs of a run, not every pair in it', () => {
    // Two models in one run; only the named pair may contribute rows.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, measurement_revision)
         VALUES ('run-1', 'efficient', 'decider', 'platform', 'completed', '2026-11-01T00:00:00.000Z',
           0.7, 3, 0, 3, 'engine', 3)`
      )
      .run();
    const insert = sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, rep,
        timed_out, prompt_revision)
       VALUES ('run-1', ?, 'high', ?, 1, 10, 0, 0, 3)`
    );
    for (let index = 0; index < 50; index += 1) insert.run('vendor/measured', `case-${index}`);
    for (let index = 0; index < 500; index += 1) insert.run('vendor/ignored', `case-${index}`);

    const rows = sqlite
      .prepare(probeCaseCountStatement(1))
      .all('run-1', 'vendor/measured', 'high', JSON.stringify(['case-0', 'case-1']), 3);
    expect(rows).toEqual([
      { run_id: 'run-1', model: 'vendor/measured', variant: 'high', probes: 2 },
    ]);
  });
});
