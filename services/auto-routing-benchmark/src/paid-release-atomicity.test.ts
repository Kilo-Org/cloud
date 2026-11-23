import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { releaseUnbilledPaidGenerationBatch } from './db';
import { releasePaidCaseGenerationStatements } from './paid-case-store';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const ENGINE = 'engine-release';
const RUN = 'run-release';
const KEY = {
  engineIdentity: ENGINE,
  model: 'vendor/model',
  variant: '',
  rep: 0,
  caseId: 'case-a',
};
const EXECUTOR = { runId: RUN, token: 'token-1', startedAt: NOW };

/**
 * Release and ledger clearing must be all-or-nothing, on real production migrations:
 * a refused release (native proof that inference may have run) must never clear the ledger,
 * and a granted release must clear it in the same transaction.
 */
describe('unbilled generation release (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, benchmark_user_id,
          benchmark_org_id, admission_marker)
        VALUES (?, 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 1, 1, ?, 'bot', 'org', ?)`
      )
      .run(RUN, new Date(NOW).toISOString(), ENGINE, crypto.randomUUID());
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids,
          status, token, slot, lease_until, attempts)
        VALUES ('chunk-1', ?, 'vendor/model', '', '[]', 0, 0, '["case-a"]', 'active', 'token-1',
          0, ?, 1)`
      )
      .run(RUN, NOW + 600_000);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (engine_identity, model, variant, rep, case_id, status,
          generation, executor_run_id, executor_token, platform_covered, result_usable,
          created_at, updated_at, started_at)
        VALUES (?, 'vendor/model', '', 0, 'case-a', 'running', 3, ?, 'token-1', 0, 0, ?, ?, ?)`
      )
      .run(
        ENGINE,
        RUN,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString()
      );
    sqlite
      .prepare(
        `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token, started_at,
          prompt_revision) VALUES (?, 'vendor/model', '', 0, 'case-a', 'token-1', ?, 3)`
      )
      .run(RUN, NOW);
    sqlite
      .prepare(
        `INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload,
          prompt_revision) VALUES (?, 'vendor/model', '', 'case-a', 0, '{}', 3)`
      )
      .run(RUN);
  });

  afterEach(() => sqlite.close());

  const state = () => ({
    run: sqlite
      .prepare(
        `SELECT status, generation, executor_run_id FROM benchmark_case_runs
        WHERE engine_identity = ? AND case_id = 'case-a'`
      )
      .get(ENGINE),
    ledger: sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_executions').get(),
    pending: sqlite.prepare('SELECT COUNT(*) AS n FROM pending_decider_outputs').get(),
  });

  function batch() {
    return releaseUnbilledPaidGenerationBatch(db, {
      release: releasePaidCaseGenerationStatements(db, {
        key: KEY,
        generation: { runId: RUN, token: 'token-1', generation: 3 },
      }),
      key: KEY,
      executor: EXECUTOR,
      generation: 3,
    });
  }

  it('clears the ledger only in the transaction that queues the case run', async () => {
    const results = await db.batch(batch());
    expect(results[0]?.meta.changes).toBe(1);
    expect(state()).toEqual({
      run: { status: 'queued', generation: 3, executor_run_id: null },
      ledger: { n: 0 },
      pending: { n: 0 },
    });
  });

  it('keeps the ledger when native proof makes the release a no-op', async () => {
    // A recorded model request past `selecting` proves inference may have run.
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests (id, engine_identity, model, variant, rep, case_id,
          generation, state, created_at, updated_at)
        VALUES ('req-1', ?, 'vendor/model', '', 0, 'case-a', 3, 'admitted', ?, ?)`
      )
      .run(ENGINE, new Date(NOW).toISOString(), new Date(NOW).toISOString());

    const results = await db.batch(batch());

    expect(results[0]?.meta.changes).toBe(0);
    // Nothing was reopened and nothing was cleared: the case is quarantined as uncertain.
    expect(state()).toEqual({
      run: { status: 'running', generation: 3, executor_run_id: RUN },
      ledger: { n: 1 },
      pending: { n: 1 },
    });
  });

  it('never clears a different generation or another attempt', async () => {
    // Another slot of this run, held by a different token: only our own row may be cleared.
    sqlite
      .prepare(
        `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token, started_at,
          prompt_revision) VALUES (?, 'vendor/other', '', 0, 'case-b', 'token-other', ?, 3)`
      )
      .run(RUN, NOW + 1);

    await db.batch(batch());

    // Ours is gone; the other slot's row is untouched.
    expect(sqlite.prepare('SELECT token FROM scheduler_executions ORDER BY token').all()).toEqual([
      { token: 'token-other' },
    ]);
  });

  it('leaves both states untouched when the batch fails mid-way', async () => {
    sqlite.exec(`
      CREATE TRIGGER block_ledger_delete BEFORE DELETE ON scheduler_executions
      WHEN OLD.token = 'token-1'
      BEGIN SELECT RAISE(ABORT, 'crash'); END;
    `);
    await expect(db.batch(batch())).rejects.toThrow();
    sqlite.exec('DROP TRIGGER block_ledger_delete');

    // All-or-nothing: the release and both deletes rolled back together, so the case run is
    // still `running` under this token, its ledger row is intact and its pending output is
    // still there. Nothing is half-queued and nothing is half-cleared.
    expect(state()).toEqual({
      run: { status: 'running', generation: 3, executor_run_id: RUN },
      ledger: { n: 1 },
      pending: { n: 1 },
    });
  });
});
