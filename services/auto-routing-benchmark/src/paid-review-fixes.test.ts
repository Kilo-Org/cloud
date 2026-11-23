import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  failPaidCasesForUnavailablePair,
  failPaidCasesForUnavailablePairStatements,
  listPendingPaidCancellations,
} from './db';
import { failScheduledEntryStatements } from './scheduler';
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

  it('fails only the target pair when another pair shares case_id and rep', async () => {
    // Two models, two variants and two engines, all with the SAME case_id and rep: a
    // rep/case correlation alone would fail every one of them.
    const pairs = [
      { engine: ENGINE, model: 'vendor/a', variant: 'low', requestId: 'req-a' },
      { engine: ENGINE, model: 'vendor/a', variant: 'high', requestId: 'req-a-high' },
      { engine: ENGINE, model: 'vendor/b', variant: 'low', requestId: 'req-b' },
      { engine: OTHER_ENGINE, model: 'vendor/a', variant: 'low', requestId: 'req-other' },
    ];
    for (const pair of pairs) {
      sqlite
        .prepare(
          `INSERT INTO benchmark_case_runs (engine_identity, model, variant, rep, case_id,
            status, generation, platform_covered, result_usable, created_at, updated_at)
          VALUES (?, ?, ?, 0, 'shared-case', 'running', 1, 0, 0, ?, ?)`
        )
        .run(
          pair.engine,
          pair.model,
          pair.variant,
          new Date(NOW).toISOString(),
          new Date(NOW).toISOString()
        );
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_requests (id, owner_type, owner_id, router, router_id,
            pool_version, engine_identity, status, quote_id, estimate_microdollars,
            maximum_microdollars, actor_user_id, context, created_at, updated_at)
          VALUES (?, 'user', 'u', 'efficient', ?, 'v', ?, 'active', 'q', 0, 0, 'u', '{}', ?, ?)`
        )
        .run(
          pair.requestId,
          `router-${pair.requestId}`,
          pair.engine,
          new Date(NOW).toISOString(),
          new Date(NOW).toISOString()
        );
      sqlite
        .prepare(
          `INSERT INTO paid_benchmark_request_cases (request_id, engine_identity, model, variant,
            rep, case_id, status, covered_by_kilo, charged_microdollars, updated_at)
          VALUES (?, ?, ?, ?, 0, 'shared-case', 'running', 0, 0, ?)`
        )
        .run(pair.requestId, pair.engine, pair.model, pair.variant, new Date(NOW).toISOString());
    }

    const failed = await failPaidCasesForUnavailablePair(db, {
      engineIdentity: ENGINE,
      model: 'vendor/a',
      variant: 'low',
      reason: 'unavailable',
      transitionId: 'transition-pair',
      now: NOW,
    });
    expect(failed).toBe(1);

    // Only the target pair's case run failed; the exact same rep/case on every other pair
    // (other variant, other model, other engine) is untouched.
    expect(
      sqlite
        .prepare(
          `SELECT model, variant, engine_identity, status FROM benchmark_case_runs
          ORDER BY engine_identity, model, variant`
        )
        .all()
    ).toEqual([
      { model: 'vendor/a', variant: 'low', engine_identity: OTHER_ENGINE, status: 'running' },
      { model: 'vendor/a', variant: 'high', engine_identity: ENGINE, status: 'running' },
      { model: 'vendor/a', variant: 'low', engine_identity: ENGINE, status: 'failed' },
      { model: 'vendor/b', variant: 'low', engine_identity: ENGINE, status: 'running' },
    ]);
    expect(
      sqlite
        .prepare(`SELECT request_id, status FROM paid_benchmark_request_cases ORDER BY request_id`)
        .all()
    ).toEqual([
      { request_id: 'req-a', status: 'failed' },
      { request_id: 'req-a-high', status: 'running' },
      { request_id: 'req-b', status: 'running' },
      { request_id: 'req-other', status: 'running' },
    ]);
  });

  it('commits the lane death and the paid-link fence atomically, then on retry', async () => {
    // One batch carries the scheduler's terminal-lane writes and the paid-link
    // terminalization. A rejected batch must leave BOTH states untouched, so the lane can be
    // retried as pure metadata on a later pass; a committed batch applies both.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, benchmark_user_id,
          benchmark_org_id, admission_marker)
        VALUES ('lane-run', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 1, 1, ?,
          'bot', 'org', ?)`
      )
      .run(new Date(NOW).toISOString(), ENGINE, crypto.randomUUID());
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk,
          case_ids, status, token, slot, lease_until, attempts)
        VALUES ('lane-chunk', 'lane-run', 'vendor/m', '', '[]', 0, 0, '["case-dead"]', 'active',
          'lane-token', 0, ?, 6)`
      )
      .run(NOW + 600_000);
    caseRun({ caseId: 'case-dead' });
    requestCase('req-dead', 'case-dead');

    const claim = {
      id: 'lane-chunk',
      run_id: 'lane-run',
      model: 'vendor/m',
      variant: '',
      rep: 0,
      chunk: 0,
      case_ids: '["case-dead"]',
      slot: 0,
      token: 'lane-token',
      attempts: 6,
      throttle_deferrals: 0,
      catalog_deferrals: 0,
    };
    const batch = () => [
      ...failScheduledEntryStatements(db, claim, 'model_not_found', new Date(NOW).toISOString()),
      ...failPaidCasesForUnavailablePairStatements(db, {
        engineIdentity: ENGINE,
        model: 'vendor/m',
        variant: '',
        reason: 'unavailable',
        transitionId: 'lane-fence',
        now: NOW,
      }),
    ];
    const state = () => ({
      lane: sqlite
        .prepare("SELECT COUNT(*) AS n FROM run_lane_failures WHERE run_id = 'lane-run'")
        .get(),
      chunk: sqlite.prepare("SELECT status FROM scheduler_chunks WHERE id = 'lane-chunk'").get(),
      caseRun: sqlite
        .prepare("SELECT status FROM benchmark_case_runs WHERE case_id = 'case-dead'")
        .get(),
      link: sqlite
        .prepare("SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'req-dead'")
        .get(),
    });

    // Rejected batch: a trigger aborts the paid-link statement, so the whole batch rolls back.
    sqlite.exec(`
      CREATE TRIGGER block_link BEFORE UPDATE ON paid_benchmark_request_cases
      BEGIN SELECT RAISE(ABORT, 'D1 overloaded'); END;
    `);
    await expect(db.batch(batch())).rejects.toThrow();
    sqlite.exec('DROP TRIGGER block_link');
    expect(state()).toEqual({
      lane: { n: 0 },
      chunk: { status: 'active' },
      caseRun: { status: 'running' },
      link: { status: 'running' },
    });

    // Retry, metadata only: both halves now commit together.
    await db.batch(batch());
    expect(state()).toEqual({
      lane: { n: 1 },
      chunk: { status: 'failed' },
      caseRun: { status: 'failed' },
      link: { status: 'failed' },
    });
  });

  it('writes nothing at all from a stale claim, and never re-selects a later generation', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, benchmark_user_id,
          benchmark_org_id, admission_marker)
        VALUES ('lane-run', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 1, 1, ?,
          'bot', 'org', ?)`
      )
      .run(new Date(NOW).toISOString(), ENGINE, crypto.randomUUID());
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk,
          case_ids, status, token, slot, lease_until, attempts)
        VALUES ('lane-chunk', 'lane-run', 'vendor/m', '', '[]', 0, 0, '["case-dead"]', 'active',
          'live-token', 0, ?, 6)`
      )
      .run(NOW + 600_000);
    caseRun({ caseId: 'case-dead' });
    requestCase('req-dead', 'case-dead');
    const claim = (token: string) => ({
      id: 'lane-chunk',
      run_id: 'lane-run',
      model: 'vendor/m',
      variant: '',
      rep: 0,
      chunk: 0,
      case_ids: '["case-dead"]',
      slot: 0,
      token,
      attempts: 6,
      throttle_deferrals: 0,
      catalog_deferrals: 0,
    });
    const batch = (token: string) => [
      ...failPaidCasesForUnavailablePairStatements(db, {
        engineIdentity: ENGINE,
        model: 'vendor/m',
        variant: '',
        reason: 'unavailable',
        transitionId: 'lane-fence',
        claim: { id: 'lane-chunk', token },
        now: NOW,
      }),
      ...failScheduledEntryStatements(
        db,
        claim(token),
        'model_not_found',
        new Date(NOW).toISOString()
      ),
    ];
    const state = () => ({
      lane: sqlite
        .prepare("SELECT COUNT(*) AS n FROM run_lane_failures WHERE run_id = 'lane-run'")
        .get(),
      chunk: sqlite.prepare("SELECT status FROM scheduler_chunks WHERE id = 'lane-chunk'").get(),
      caseRun: sqlite
        .prepare("SELECT status FROM benchmark_case_runs WHERE case_id = 'case-dead'")
        .get(),
      link: sqlite
        .prepare("SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'req-dead'")
        .get(),
    });

    // A stale claim writes nothing: not the links, not the lane.
    await db.batch(batch('stale-token'));
    expect(state()).toEqual({
      lane: { n: 0 },
      chunk: { status: 'active' },
      caseRun: { status: 'running' },
      link: { status: 'running' },
    });

    // The exact live token commits both halves together.
    await db.batch(batch('live-token'));
    expect(state()).toEqual({
      lane: { n: 1 },
      chunk: { status: 'failed' },
      caseRun: { status: 'failed' },
      link: { status: 'failed' },
    });

    // Repeating the same metadata pass is a no-op: the settled generation is not
    // re-transitioned and no later generation is selected.
    await db.batch(batch('live-token'));
    expect(state()).toEqual({
      lane: { n: 1 },
      chunk: { status: 'failed' },
      caseRun: { status: 'failed' },
      link: { status: 'failed' },
    });
  });

  it('fences a reclaimed generation that still carries an old settlement id', async () => {
    // The store bumps `generation` on reclaim and claim without clearing `settlement_id` and
    // `settled_at`. A genuinely live generation therefore looks like this: status
    // `running`, a *new* executor, and a stale settlement id from the cancelled attempt. The
    // owned-claim fence must let its own lane terminalize it, and must still refuse a stale
    // former claim.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, benchmark_user_id,
          benchmark_org_id, admission_marker)
        VALUES ('lane-run', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 1, 1, ?,
          'bot', 'org', ?)`
      )
      .run(new Date(NOW).toISOString(), ENGINE, crypto.randomUUID());
    sqlite
      .prepare(
        `INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk,
          case_ids, status, token, slot, lease_until, attempts)
        VALUES ('lane-chunk', 'lane-run', 'vendor/m', '', '[]', 0, 0, '["case-dead"]', 'active',
          'new-token', 0, ?, 6)`
      )
      .run(NOW + 600_000);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (engine_identity, model, variant, rep, case_id, status,
          generation, executor_run_id, executor_token, platform_covered, result_usable,
          settlement_id, settled_at, created_at, updated_at)
        VALUES (?, 'vendor/m', '', 0, 'case-dead', 'running', 5, 'lane-run', 'new-token', 0, 0,
          'old-cancel-settlement', ?, ?, ?)`
      )
      .run(
        ENGINE,
        new Date(NOW - 60_000).toISOString(),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString()
      );
    requestCase('req-dead', 'case-dead');

    const batch = (token: string) =>
      failPaidCasesForUnavailablePairStatements(db, {
        engineIdentity: ENGINE,
        model: 'vendor/m',
        variant: '',
        reason: 'unavailable',
        transitionId: `unavailable:lane-run:vendor/m::lane-chunk:${token}`,
        claim: { id: 'lane-chunk', token },
        now: NOW,
      });
    const state = () => ({
      caseRun: sqlite
        .prepare(
          `SELECT status, settlement_id FROM benchmark_case_runs WHERE case_id = 'case-dead'`
        )
        .get(),
      link: sqlite
        .prepare("SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'req-dead'")
        .get(),
    });

    // The stale former claim writes nothing, even though the row is genuinely live.
    await db.batch(batch('old-token'));
    expect(state()).toEqual({
      caseRun: { status: 'running', settlement_id: 'old-cancel-settlement' },
      link: { status: 'running' },
    });

    // The exact current claim terminalizes both halves and replaces the stale metadata.
    await db.batch(batch('new-token'));
    expect(state()).toEqual({
      caseRun: {
        status: 'failed',
        settlement_id: 'unavailable:lane-run:vendor/m::lane-chunk:new-token',
      },
      link: { status: 'failed' },
    });
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
