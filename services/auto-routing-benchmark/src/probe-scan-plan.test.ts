import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countProbeCaseResults, probeCaseCountStatement } from './db';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';

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

  function insertRun(id: string) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, measurement_revision)
         VALUES (?, 'efficient', 'decider', 'platform', 'completed', '2026-11-01T00:00:00.000Z',
           0.7, 3, 0, 3, 'engine', 3)`
      )
      .run(id);
  }

  function insertCase(runId: string, model: string, caseId: string, rep = 0, revision = 3) {
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, rep,
          timed_out, prompt_revision)
         VALUES (?, ?, 'high', ?, 1, 10, ?, 0, ?)`
      )
      .run(runId, model, caseId, rep, revision);
  }

  it('seeks each named pair on the full composite primary key', () => {
    const statementPlan = plan(probeCaseCountStatement(2));
    expect(statementPlan).toContain(
      'SEARCH measured USING INDEX sqlite_autoindex_case_results_1 (run_id=? AND model=? AND variant=? AND case_id=?)'
    );
    // The expensive shape this replaced: a seek on the first key column only.
    expect(statementPlan).not.toMatch(
      /^SEARCH measured USING (COVERING )?INDEX sqlite_autoindex_case_results_1 \(run_id=\?\)/m
    );
    expect(statementPlan).not.toMatch(/^SCAN measured\b/m);
  });

  it('reads only the named pairs of a run, not every pair in it', () => {
    insertRun('run-1');
    // Two models and three repetitions in one run; only the named pair may contribute rows.
    for (let index = 0; index < 50; index += 1) {
      for (let rep = 0; rep < 3; rep += 1) {
        insertCase('run-1', 'vendor/measured', `case-${index}`, rep);
      }
    }
    for (let index = 0; index < 500; index += 1) {
      insertCase('run-1', 'vendor/ignored', `case-${index}`);
    }

    const rows = sqlite
      .prepare(probeCaseCountStatement(1))
      .all('run-1', 'vendor/measured', 'high', JSON.stringify(['case-0', 'case-1']), 3);
    // One row for the named pair: two distinct probe cases, three repetitions each.
    expect(rows).toEqual([
      { run_id: 'run-1', model: 'vendor/measured', variant: 'high', probes: 2 },
    ]);
  });

  it('keeps a full batch inside the 100-variable statement bound', async () => {
    // 30 pairs per statement is the batch the function uses; sqliteD1 throws on bind() above
    // D1's ceiling, so a 30-pair call proves the batch size still fits.
    const db = sqliteD1(sqlite);
    insertRun('run-1');
    insertCase('run-1', 'vendor/measured', 'case-0');
    const rows = await countProbeCaseResults(db, {
      pairs: Array.from({ length: 30 }, (_, index) => ({
        runId: 'run-1',
        model: index === 0 ? 'vendor/measured' : `vendor/model-${index}`,
        variant: 'high',
      })),
      caseIds: ['case-0', 'case-1'],
      revision: 3,
    });
    expect(rows).toHaveLength(30);
    expect(rows.find(row => row.model === 'vendor/measured')!.probes).toBe(1);
  });
});
