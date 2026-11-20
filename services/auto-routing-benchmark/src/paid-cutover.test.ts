import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  computeEngineIdentity,
  dispatchScheduler,
  processJob,
  retireLegacyRunsAtCutover,
} from './run';
import { scheduleRunChunks } from './scheduler';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const CUTOVER = new Date(NOW).toISOString();
const LEGACY_STARTED = new Date(NOW - 60_000).toISOString();
const SLOTS = JSON.stringify({ slots: 2 });
const ENGINE = computeEngineIdentity('decider', 'efficient');

/**
 * The paid cutover on real production migrations: a platform activation run and a legacy
 * user run that were running when the deploy landed must be fenced — no chunk claimed, no
 * provider call, no registry row re-queued — while every measured row, summary and the
 * published routing artifact stay byte-identical.
 */
describe('paid cutover fences legacy measurement (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let sent: unknown[];
  let providerCalls: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    providerCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      providerCalls += 1;
      throw new Error('the cutover must not reach the provider');
    });
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sqlite.prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)').run(CUTOVER);
    sent = [];
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: {
        async send(body: unknown) {
          sent.push(body);
        },
      },
      BENCH_RUNNER: {
        idFromName: (name: string) => name,
        get: () => {
          throw new Error('the cutover must not start a container');
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: SLOTS,
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function insertRun(
    id: string,
    purpose: 'platform' | 'user',
    startedAt: string,
    model = 'lane/model'
  ) {
    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
        max_concurrency, repetitions, engine_identity, benchmark_user_id, benchmark_org_id
      ) VALUES (?, 'efficient', 'decider', ?, 'running', ?, 0.7, 3, 0, 1, ?, 'bot', 'org')
    `)
      .run(id, purpose, startedAt, ENGINE);
    // No admission_marker: this fixture is the legacy/older-image writer. Its started_at may
    // even be after the cutover, and the marker is what fences it.
    sqlite
      .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
      .run(id, model);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', ?, '', ?, 1, 'running', ?, ?, ?, ?, ?)`
      )
      .run(
        model,
        ENGINE,
        id,
        LEGACY_STARTED,
        LEGACY_STARTED,
        purpose === 'platform' ? 1 : 0,
        purpose === 'user' ? 1 : 0
      );
  }

  it('keeps unchanged artifacts, starts no provider work and parks both queues', async () => {
    // A completed run with measurements and a published artifact is the "real history".
    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at, completed_at, min_accuracy,
        switch_cost_factor, max_concurrency, repetitions, engine_identity,
        benchmark_user_id, benchmark_org_id
      ) VALUES ('measured', 'efficient', 'decider', 'platform', 'completed', ?, ?, 0.7, 3, 0, 1, ?,
        'bot', 'org')
    `)
      .run(
        new Date(NOW - 3_600_000).toISOString(),
        new Date(NOW - 3_000_000).toISOString(),
        ENGINE
      );
    sqlite
      .prepare(
        "INSERT INTO run_models (run_id, model, variant, enqueued) VALUES ('measured', 'lane/model', '', 1)"
      )
      .run();
    const caseResult = DECIDER_CASES[0];
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, exit_code,
          timed_out, prompt_revision) VALUES ('measured', 'lane/model', '', ?, 1, 10, 0, 0, 3)`
      )
      .run(caseResult.id);
    sqlite
      .prepare(
        `INSERT INTO routing_tables (run_id, router, published_at, generated_at, min_accuracy,
          switch_cost_factor, source, desired_pairs)
        VALUES ('v-measured', 'efficient', ?, ?, 0.7, 3, 'benchmark', ?)`
      )
      .run(
        new Date(NOW - 2_000_000).toISOString(),
        new Date(NOW - 2_000_000).toISOString(),
        JSON.stringify(['lane/model'])
      );
    const artifactBefore = sqlite
      .prepare('SELECT run_id, published_at, generated_at, desired_pairs FROM routing_tables')
      .all();
    const resultsBefore = sqlite
      .prepare('SELECT run_id, model, case_id, score, latency_ms, exit_code FROM case_results')
      .all();

    insertRun('legacy-platform', 'platform', LEGACY_STARTED, 'platform/model');
    insertRun('legacy-user', 'user', LEGACY_STARTED, 'user/model');
    // Real chunks exist for both runs, exactly as a pre-cutover dispatch left them.
    for (const runId of ['legacy-platform', 'legacy-user']) {
      await scheduleRunChunks(env.BENCH_DB, {
        runId,
        entries:
          runId === 'legacy-platform'
            ? [{ model: 'platform/model', variant: null }]
            : [{ model: 'user/model', variant: null }],
        repetitions: 1,
        caseIds: DECIDER_CASES.slice(0, 3).map(benchCase => benchCase.id),
        chunkSize: 1,
      });
    }
    const chunksBefore = sqlite
      .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status = 'pending'")
      .get() as { n: number };
    expect(chunksBefore.n).toBeGreaterThan(0);

    // Same resume attempt: the very dispatch pass the deploy runs.
    await dispatchScheduler(env);

    // 1. Both runs are terminal and fenced.
    expect(
      sqlite
        .prepare("SELECT id, status FROM benchmark_runs WHERE id LIKE 'legacy-%' ORDER BY id")
        .all()
    ).toEqual([
      { id: 'legacy-platform', status: 'failed' },
      { id: 'legacy-user', status: 'failed' },
    ]);
    // 2. No chunk of either legacy run was claimed for execution.
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id LIKE 'legacy-%' AND status = 'active'"
        )
        .get()
    ).toEqual({ n: 0 });
    // 3. No provider call, no container, no queue work.
    expect(providerCalls).toBe(0);
    expect(sent).toEqual([]);
    // 4. Registry claims are parked, not failed, so nothing re-enqueues and no failure is
    //    counted against the pair.
    expect(
      sqlite
        .prepare(
          `SELECT model, status, run_id, requested_at, failure_attempts, failure_class
          FROM benchmark_profiles ORDER BY model`
        )
        .all()
    ).toEqual([
      {
        model: 'platform/model',
        status: 'pending',
        run_id: null,
        requested_at: '1970-01-01T00:00:00.000Z',
        failure_attempts: 0,
        failure_class: null,
      },
      {
        model: 'user/model',
        status: 'pending',
        run_id: null,
        requested_at: '1970-01-01T00:00:00.000Z',
        failure_attempts: 0,
        failure_class: null,
      },
    ]);
    // 5. Measured rows and the published artifact are untouched, byte for byte.
    expect(
      sqlite
        .prepare('SELECT run_id, published_at, generated_at, desired_pairs FROM routing_tables')
        .all()
    ).toEqual(artifactBefore);
    expect(
      sqlite
        .prepare('SELECT run_id, model, case_id, score, latency_ms, exit_code FROM case_results')
        .all()
    ).toEqual(resultsBefore);
    // 6. A later pass is a no-op: nothing is retired again and nothing is dispatched.
    await dispatchScheduler(env);
    expect(providerCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  it('claims nothing when the retirement write fails (fail closed)', async () => {
    insertRun('legacy-platform', 'platform', LEGACY_STARTED);
    await scheduleRunChunks(env.BENCH_DB, {
      runId: 'legacy-platform',
      entries: [{ model: 'lane/model', variant: null }],
      repetitions: 1,
      caseIds: DECIDER_CASES.slice(0, 2).map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    sqlite
      .prepare(
        `INSERT INTO scheduler_runs (run_id) VALUES ('legacy-platform') ON CONFLICT DO NOTHING`
      )
      .run();
    // Make the retirement UPDATE fail, as a D1 fault would.
    sqlite.exec(`
      CREATE TRIGGER block_retire BEFORE UPDATE ON benchmark_runs
      BEGIN SELECT RAISE(ABORT, 'D1 fault'); END;
    `);
    await dispatchScheduler(env);
    sqlite.exec('DROP TRIGGER block_retire');

    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'legacy-platform'").get()
    ).toEqual({ status: 'running' });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id = 'legacy-platform' AND status != 'pending'"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(providerCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  it('fences a replayed legacy queue message without a container or provider call', async () => {
    insertRun('legacy-user', 'user', LEGACY_STARTED);
    await scheduleRunChunks(env.BENCH_DB, {
      runId: 'legacy-user',
      entries: [{ model: 'lane/model', variant: null }],
      repetitions: 1,
      caseIds: DECIDER_CASES.slice(0, 1).map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    sqlite
      .prepare(`INSERT INTO scheduler_runs (run_id) VALUES ('legacy-user') ON CONFLICT DO NOTHING`)
      .run();
    // The message was delivered before the deploy: its chunk is already queued with a token,
    // exactly as the old dispatcher left it (the new claim SQL would refuse it).
    sqlite
      .prepare(
        `UPDATE scheduler_chunks SET status = 'queued', token = 'old-token', slot = 0,
          lease_until = ?
        WHERE run_id = 'legacy-user'`
      )
      .run(NOW + 60_000);
    const claim = sqlite
      .prepare("SELECT * FROM scheduler_chunks WHERE run_id = 'legacy-user' LIMIT 1")
      .get() as { id: string; token: string; model: string };
    // The deploy's dispatcher never saw this run; the message was already delivered.
    await processJob(env, {
      runId: 'legacy-user',
      kind: 'decider',
      model: claim.model,
      claimId: claim.id,
      claimToken: claim.token,
    });
    expect(providerCalls).toBe(0);
    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'legacy-user'").get()
    ).toEqual({ status: 'failed' });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM run_lane_failures WHERE run_id = 'legacy-user'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('fences a legacy writer that inserted a run after the cutover', async () => {
    // The deploy-overlap case: an older image commits a run with a LATER timestamp than the
    // cutover. `started_at` cannot distinguish it; the missing admission marker does.
    insertRun('late-legacy', 'platform', new Date(NOW + 60_000).toISOString(), 'late/model');
    await scheduleRunChunks(env.BENCH_DB, {
      runId: 'late-legacy',
      entries: [{ model: 'late/model', variant: null }],
      repetitions: 1,
      caseIds: DECIDER_CASES.slice(0, 2).map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    sqlite
      .prepare(`INSERT INTO scheduler_runs (run_id) VALUES ('late-legacy') ON CONFLICT DO NOTHING`)
      .run();
    const chunks = sqlite
      .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id = 'late-legacy'")
      .get();

    await dispatchScheduler(env);

    expect(providerCalls).toBe(0);
    expect(sent).toEqual([]);
    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'late-legacy'").get()
    ).toEqual({ status: 'failed' });
    // Its chunks were never claimed, and no measured row was created or changed.
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id = 'late-legacy' AND status = 'active'"
        )
        .get()
    ).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM case_results').get()).toEqual({ n: 0 });
    expect(chunks).toEqual({ n: 2 });
  });

  it('keeps a paid-flow run admitted before the first scheduler tick', async () => {
    insertRun('new-paid', 'user', LEGACY_STARTED);
    sqlite
      .prepare('UPDATE benchmark_runs SET admission_marker = ? WHERE id = ?')
      .run('paid-flow', 'new-paid');

    expect(await retireLegacyRunsAtCutover(env, CUTOVER)).toBe(0);
    expect(sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'new-paid'").get()).toEqual(
      {
        status: 'running',
      }
    );
    expect(
      sqlite.prepare("SELECT status FROM benchmark_profiles WHERE run_id = 'new-paid'").get()
    ).toEqual({ status: 'running' });
  });

  it('keeps a ready profile a retired run still points at', async () => {
    // A partially measured or admin-cancelled run can still be the provenance of a `ready`
    // row. Parking it would strip a valid, already-published measurement from the pool.
    insertRun('legacy-platform', 'platform', LEGACY_STARTED, 'ready/model');
    // The run claimed this pair and had already published it before it was retired.
    sqlite
      .prepare(
        `UPDATE benchmark_profiles
        SET status = 'ready', run_id = 'legacy-platform', completed_at = ?
        WHERE model = 'ready/model'`
      )
      .run(LEGACY_STARTED);
    // Its published measurement stays too.
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, exit_code,
          timed_out, prompt_revision)
        VALUES ('legacy-platform', 'ready/model', '', ?, 1, 10, 0, 0, 3)`
      )
      .run(DECIDER_CASES[0].id);

    expect(await retireLegacyRunsAtCutover(env, CUTOVER)).toBeGreaterThan(0);

    // The run is fenced, but the ready row keeps its status, provenance and measurement.
    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'legacy-platform'").get()
    ).toEqual({ status: 'failed' });
    expect(
      sqlite
        .prepare(
          `SELECT status, run_id, completed_at FROM benchmark_profiles WHERE model = 'ready/model'`
        )
        .get()
    ).toEqual({ status: 'ready', run_id: 'legacy-platform', completed_at: LEGACY_STARTED });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM case_results WHERE model = 'ready/model'").get()
    ).toEqual({ n: 1 });
  });

  it('retires a single run idempotently, leaving its measured rows alone', async () => {
    insertRun('legacy-platform', 'platform', LEGACY_STARTED);
    expect(await retireLegacyRunsAtCutover(env, CUTOVER)).toBe(1);
    expect(await retireLegacyRunsAtCutover(env, CUTOVER)).toBe(0);
    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'legacy-platform'").get()
    ).toEqual({ status: 'failed' });
  });
});
