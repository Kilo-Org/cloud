import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { failPaidCasesForUnavailablePair, listPendingPaidCancellations } from './db';
import { permanentFailureVetoes } from './case-inference';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const ENGINE = 'engine-slice';
const OTHER_ENGINE = 'engine-other';

/**
 * The four defects this slice fixes, each proven against the real migration set through the
 * strict bind-counting D1 adapter.
 */
describe('paid-benchmark review fixes (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  afterEach(() => sqlite.close());

  function caseRun(overrides: {
    caseId: string;
    rep?: number;
    status?: string;
    engine?: string;
    settlementId?: string | null;
  }) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (engine_identity, model, variant, rep, case_id, status,
          generation, platform_covered, result_usable, settlement_id, created_at, updated_at)
        VALUES (?, 'vendor/m', '', ?, ?, ?, 1, 0, 0, ?, ?, ?)`
      )
      .run(
        overrides.engine ?? ENGINE,
        overrides.rep ?? 0,
        overrides.caseId,
        overrides.status ?? 'running',
        overrides.settlementId ?? null,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString()
      );
  }

  function requestCase(requestId: string, caseId: string, rep = 0, status = 'running') {
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests (id, owner_type, owner_id, router, router_id,
          pool_version, engine_identity, status, quote_id, estimate_microdollars,
          maximum_microdollars, actor_user_id, context, created_at, updated_at)
        VALUES (?, 'user', 'u', 'efficient', ?, 'v', ?, 'active', 'q', 0, 0, 'u', '{}', ?, ?)`
      )
      .run(
        requestId,
        `router-${requestId}`,
        ENGINE,
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString()
      );
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases (request_id, engine_identity, model, variant,
          rep, case_id, status, covered_by_kilo, charged_microdollars, updated_at)
        VALUES (?, ?, 'vendor/m', '', ?, ?, ?, 0, 0, ?)`
      )
      .run(requestId, ENGINE, rep, caseId, status, new Date(NOW).toISOString());
  }

  it('fails only the correlated request rows, accepting the batch on strict D1', async () => {
    // Two rep/case combinations of the pair, plus a settled earlier result and a later row.
    caseRun({ caseId: 'case-a', rep: 0 });
    caseRun({ caseId: 'case-b', rep: 1 });
    caseRun({ caseId: 'case-c', rep: 0 });
    caseRun({ caseId: 'case-settled', rep: 0, status: 'settled', settlementId: 'old' });
    caseRun({ caseId: 'case-other', rep: 0 });
    requestCase('req-a0', 'case-a', 0);
    requestCase('req-b1', 'case-b', 1);
    requestCase('req-c0', 'case-c', 0);
    requestCase('req-settled', 'case-settled', 0);
    requestCase('req-other', 'case-other', 0);
    requestCase('req-done', 'case-c', 0, 'done');

    // The strict adapter throws on any placeholder/bind mismatch, so this call itself is the
    // proof that the statement is well-formed.
    const failed = await failPaidCasesForUnavailablePair(db, {
      engineIdentity: ENGINE,
      model: 'vendor/m',
      variant: '',
      reason: 'unavailable',
      transitionId: 'transition-1',
      now: NOW,
    });
    expect(failed).toBe(4);

    expect(
      sqlite
        .prepare(
          `SELECT case_id, rep, status FROM paid_benchmark_request_cases ORDER BY request_id`
        )
        .all()
    ).toEqual([
      { case_id: 'case-a', rep: 0, status: 'failed' },
      { case_id: 'case-b', rep: 1, status: 'failed' },
      { case_id: 'case-c', rep: 0, status: 'failed' },
      // `done` is a later/completed row and is preserved.
      { case_id: 'case-c', rep: 0, status: 'done' },
      { case_id: 'case-other', rep: 0, status: 'failed' },
      // A case run this batch did not fail leaves its request row alone.
      { case_id: 'case-settled', rep: 0, status: 'running' },
    ]);
    // The settled case run keeps its own settlement.
    expect(
      sqlite
        .prepare(
          `SELECT settlement_id FROM benchmark_case_runs
          WHERE case_id = 'case-settled' AND status = 'settled'`
        )
        .get()
    ).toEqual({ settlement_id: 'old' });
  });

  it('compares created_at as an integer epoch and excludes older intents', async () => {
    const insert = sqlite.prepare(
      `INSERT INTO paid_benchmark_cancellations (engine_identity, model, variant, rep, case_id,
        generation, executor_run_id, executor_token, status, attempts, available_at,
        created_at, updated_at)
      VALUES (?, 'vendor/m', '', 0, ?, 1, 'run-1', 'token-1', 'pending', 0, 0, ?, 0)`
    );
    insert.run(ENGINE, 'old-case', NOW - 60_000);
    insert.run(ENGINE, 'new-case', NOW + 60_000);

    const scoped = await listPendingPaidCancellations(db, NOW, 100, {
      executorRunId: 'run-1',
      createdAfter: NOW,
    });
    expect(scoped.map(intent => intent.case_id)).toEqual(['new-case']);
  });

  it('scopes the permanent veto to the exact router, engine and repetition count', async () => {
    const profile = (engine: string, router: string, repetitions: number, status: string) =>
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
            status, run_id, requested_at, updated_at, platform_requested, user_requested)
          VALUES (?, 'vendor/m', '', ?, ?, ?, NULL, ?, ?, 1, 0)`
        )
        .run(
          router,
          engine,
          repetitions,
          status,
          new Date(NOW).toISOString(),
          new Date(NOW).toISOString()
        );
    profile(ENGINE, 'efficient', 3, 'unavailable');
    profile(ENGINE, 'frontier', 3, 'ready');
    profile(OTHER_ENGINE, 'efficient', 3, 'ready');
    profile(ENGINE, 'efficient', 1, 'ready');

    const key = { engineIdentity: ENGINE, model: 'vendor/m', variant: '', rep: 0, caseId: 'c' };
    expect(await permanentFailureVetoes(db, key, { router: 'efficient', repetitions: 3 })).toBe(
      true
    );
    // A different router, engine or repetition count is a different measurement: permitted.
    expect(await permanentFailureVetoes(db, key, { router: 'frontier', repetitions: 3 })).toBe(
      false
    );
    expect(
      await permanentFailureVetoes(
        db,
        { ...key, engineIdentity: OTHER_ENGINE },
        { router: 'efficient', repetitions: 3 }
      )
    ).toBe(false);
    expect(await permanentFailureVetoes(db, key, { router: 'efficient', repetitions: 1 })).toBe(
      false
    );
  });
});
