import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { listPendingPaidCancellations } from './db';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const RUN = 'run-wide-cancel';
const OTHER = 'run-unrelated';

/**
 * A cancellation delivery pass must stay inside D1's bound-variable ceiling no matter how
 * many cases the cancelled run owns, and must never signal another run's generations.
 */
describe('cancellation intent scoping (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    const insert = sqlite.prepare(
      `INSERT INTO paid_benchmark_cancellations (engine_identity, model, variant, rep, case_id,
        generation, executor_run_id, executor_token, status, attempts, available_at,
        created_at, updated_at)
      VALUES ('engine', 'vendor/model', '', 0, ?, 1, ?, ?, 'pending', 0, 0, ?, ?)`
    );
    // 40 cases for the cancelled run: 5 binds each would be 200, well over the ceiling.
    for (let index = 0; index < 40; index += 1) {
      insert.run(`case-${index}`, RUN, 'token-run', NOW - 1_000, NOW - 1_000);
    }
    // An unrelated run's intent, plus one of the cancelled run's that predates the cancel.
    insert.run('unrelated-case', OTHER, 'token-other', NOW - 1_000, NOW - 1_000);
  });

  afterEach(() => sqlite.close());

  it('delivers a 40-case run with one bind and no other run', async () => {
    // One bind regardless of case count; the pass is bounded, so 40 cases drain over two
    // passes and every intent is still eventually delivered.
    const first = await listPendingPaidCancellations(db, NOW, 100, { executorRunId: RUN });
    expect(first).toHaveLength(32);
    expect(new Set(first.map(intent => intent.executor_run_id))).toEqual(new Set([RUN]));
    expect(first.map(intent => intent.case_id)).not.toContain('unrelated-case');

    const markDelivered = sqlite.prepare(
      `UPDATE paid_benchmark_cancellations SET status = 'delivered'
      WHERE executor_run_id = ? AND case_id = ?`
    );
    for (const intent of first) markDelivered.run(RUN, intent.case_id);

    const second = await listPendingPaidCancellations(db, NOW, 100, { executorRunId: RUN });
    expect(second).toHaveLength(8);
    expect(second.map(intent => intent.case_id)).toContain('case-39');
    // Every one of the 40 belongs to this run.
    expect(new Set([...first, ...second].map(intent => intent.case_id)).size).toBe(40);
  });

  it('excludes intents that predate the cancel pass', async () => {
    const intents = await listPendingPaidCancellations(db, NOW, 100, {
      executorRunId: RUN,
      createdAfter: NOW,
    });
    expect(intents).toEqual([]);
  });

  it('scopes a pause to its request without ever unbinding the run filter', async () => {
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests (id, owner_type, owner_id, router, router_id,
          pool_version, engine_identity, status, quote_id, estimate_microdollars,
          maximum_microdollars, actor_user_id, context, created_at, updated_at)
        VALUES ('req-1', 'user', 'u1', 'efficient', 'r1', 'v1', 'engine', 'active', 'q1', 0, 0,
          'u1', '{}', ?, ?)`
      )
      .run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_request_cases (request_id, engine_identity, model, variant,
          rep, case_id, status, covered_by_kilo, charged_microdollars, updated_at)
        VALUES ('req-1', 'engine', 'vendor/model', '', 0, 'case-7', 'queued', 0, 0, ?)`
      )
      .run(new Date(NOW).toISOString());

    const intents = await listPendingPaidCancellations(db, NOW, 100, {
      requestId: 'req-1',
      executorRunId: RUN,
    });
    expect(intents.map(intent => intent.case_id)).toEqual(['case-7']);
    // A request filter alone never widens the run scope.
    const unscoped = await listPendingPaidCancellations(db, NOW, 100, { requestId: 'req-1' });
    expect(unscoped.map(intent => intent.case_id)).toEqual(['case-7']);
  });
});
