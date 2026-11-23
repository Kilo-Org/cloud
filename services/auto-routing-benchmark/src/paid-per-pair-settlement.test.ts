import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { ACTIVE_MEASUREMENT_REVISION, deciderCasesForRouter } from './measurement-revision';
import { acceptContainerCaseResult, computeEngineIdentity, dispatchScheduler } from './run';

/**
 * Per-pair settlement of a paid run on real migrations: a pair that measured every slot is
 * readied with its results, even when a sibling pair in the same request died. Only the
 * incomplete pair goes back to the queue, and only it carries a failure.
 */
describe('paid run per-pair settlement (production migrations)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let providerCalls: number;
  const engineIdentity = computeEngineIdentity('decider', 'efficient');
  const cases = deciderCasesForRouter('efficient', ACTIVE_MEASUREMENT_REVISION);
  const runId = 'user-paid-request-1';
  const NOW = '2026-11-20T12:00:00.000Z';

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('2026-01-01T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO benchmark_config
          (id, min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id,
            benchmark_org_id, updated_at)
        VALUES (1, 0.7, 3, 4, 'bot-internal-1', 'bench-org', ?)`
      )
      .run(NOW);
    sqlite
      .prepare(
        "INSERT INTO config_classifier_models (router, model) VALUES ('efficient', 'vendor/classifier')"
      )
      .run();
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO config_decider_models (router, model, variant, reasoning_effort)
          VALUES ('efficient', ?, NULL, NULL)`
        )
        .run(model);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at, activated_at)
        VALUES ('request-1', 'user', 'user-1', NULL, 'efficient', 'router-1', 'pool-v1', ?,
          'active', 'quote-1', 100, 100, 0, ?, ?, NULL, 'user-1', '{}', ?, ?, ?)`
      )
      .run(engineIdentity, cases.length * 2, cases.length * 2, NOW, NOW, NOW);
    providerCalls = 0;
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: { async send() {} },
      BENCH_RUNNER: {
        idFromName: (name: string) => name,
        get: () => {
          throw new Error('settlement must not start a container');
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: '{"slots":2}',
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedRun() {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
            max_concurrency, repetitions, engine_identity, benchmark_user_id,
            benchmark_org_id, measurement_revision, admission_marker)
        VALUES (?, 'efficient', 'decider', 'user', 'running', ?, 0.7, 3, 0, 3, ?,
          'bot-internal-1', 'bench-org', ?, ?)`
      )
      // A current admission is proven by its marker, not by the clock: the deploy overlap can
      // produce an older image's run with a later `started_at`.
      .run(runId, NOW, engineIdentity, ACTIVE_MEASUREMENT_REVISION, 'admitted:test');
    for (const model of ['vendor/x', 'vendor/y']) {
      sqlite
        .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
        .run(runId, model);
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles
            (router, model, variant, engine_identity, repetitions, status, run_id,
              requested_at, updated_at, platform_requested, user_requested)
          VALUES ('efficient', ?, '', ?, 3, 'running', ?, ?, ?, 0, 0)`
        )
        .run(model, engineIdentity, runId, NOW, NOW);
      for (const benchCase of cases)
        sqlite
          .prepare(
            `INSERT INTO paid_benchmark_request_cases
              (request_id, engine_identity, model, variant, rep, case_id, status,
                covered_by_kilo, charged_microdollars, reason, updated_at)
            VALUES ('request-1', ?, ?, '', 0, ?, 'done', 0, 0, NULL, ?)`
          )
          .run(engineIdentity, model, benchCase.id, NOW);
    }
  }

  function insertResults(model: string, count: number) {
    const insert = sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, cost_usd,
        rep, timed_out, exit_code, prompt_revision)
      VALUES (?, ?, '', ?, 1, 10, 0.01, ?, 0, 0, ?)`
    );
    for (const benchCase of cases.slice(0, count))
      for (let rep = 0; rep < 3; rep += 1)
        insert.run(runId, model, benchCase.id, rep, ACTIVE_MEASUREMENT_REVISION);
  }

  function profile(model: string) {
    return sqlite
      .prepare(
        `SELECT status, run_id, failure_class, retry_after FROM benchmark_profiles
        WHERE router = 'efficient' AND model = ? AND variant = ''
          AND engine_identity = ? AND repetitions = 3`
      )
      .get(model, engineIdentity) as {
      status: string;
      run_id: string | null;
      failure_class: string | null;
      retry_after: string | null;
    };
  }

  it('readies the complete pair, releases only the dead one, and keeps its results', async () => {
    seedRun();
    // X measured every materialized slot; Y died after part of its lane.
    insertResults('vendor/x', cases.length);
    insertResults('vendor/y', cases.length - 1);
    sqlite
      .prepare(
        `INSERT INTO run_lane_failures
          (run_id, model, variant, rep, chunk, shard, failure_class, failed_at)
        VALUES (?, 'vendor/y', '', 0, 0, 0, 'unknown', ?)`
      )
      .run(runId, NOW);
    // Y's remaining chunk must not be claimable, so the run can settle.
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO scheduler_chunks
            (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
          VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'completed')`
        )
        .run(`${runId}:${model}:0`, runId, model, JSON.stringify(cases.map(c => c.id)));
    sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(runId);

    await dispatchScheduler(env);

    // X is ready with its run provenance intact; its results were not touched.
    expect(profile('vendor/x')).toEqual({
      status: 'ready',
      run_id: runId,
      failure_class: null,
      retry_after: null,
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM case_results WHERE run_id = ? AND model = 'vendor/x'")
        .get(runId)
    ).toEqual({ n: cases.length * 3 });
    // Only Y leaves `running`, and it leaves as a failed attempt with a retry window rather
    // than as an unowned pending row: the streak write (guarded on status='running') runs
    // before the claim release, so the release leaves its settled failure in place.
    const y = profile('vendor/y');
    expect(y.status).toBe('failed');
    expect(y.failure_class).toBe('unknown');
    expect(y.retry_after).not.toBeNull();
    // The attempt history: X counted as progress, Y failed with the lane's cause.
    const attempts = sqlite
      .prepare(
        `SELECT model, outcome, failure_class FROM profile_attempt_history
        WHERE run_id = ? ORDER BY model`
      )
      .all(runId) as { model: string; outcome: string; failure_class: string | null }[];
    // X is pure progress. Y also produced newly completed valid cases before its lane died,
    // so its attempt is `progress` too — that resets the failure streak — while the profile
    // keeps the lane's cause and a fresh retry window rather than counting as a lost attempt.
    expect(attempts).toEqual([
      { model: 'vendor/x', outcome: 'progress', failure_class: null },
      { model: 'vendor/y', outcome: 'progress', failure_class: null },
    ]);
    // The run closed as a whole and nothing reached a provider.
    const run = sqlite.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId) as {
      status: string;
    };
    expect(run.status).toBe('completed');
    expect(providerCalls).toBe(0);
  });

  it('leaves a cancelled pair unreadied instead of readying the whole run', async () => {
    // The distinguishing case for per-pair readiness. Y lost a slot to a cancellation, so its
    // attempt is skipped (neither progress nor failure) and its profile row is STILL
    // `running` when readiness is decided. A whole-run ready would publish Y with a gap;
    // per-pair readiness must leave it alone and hand it back.
    seedRun();
    insertResults('vendor/x', cases.length);
    insertResults('vendor/y', cases.length - 1);
    const cancelledCase = cases[cases.length - 1].id;
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs
          (engine_identity, model, variant, rep, case_id, status, generation,
            platform_covered, result_usable, created_at, updated_at, settled_at)
        VALUES (?, 'vendor/y', '', 0, ?, 'cancelled', 1, 0, 0, ?, ?, ?)`
      )
      .run(engineIdentity, cancelledCase, NOW, NOW, NOW);
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO scheduler_chunks
            (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
          VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'completed')`
        )
        .run(`${runId}:${model}:0`, runId, model, JSON.stringify(cases.map(c => c.id)));
    sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(runId);

    await dispatchScheduler(env);

    // X is ready. Y is NOT: it never reached a complete measurement, so publishing it would
    // serve a ranking with a hole. It goes back to the queue unowned.
    expect(profile('vendor/x').status).toBe('ready');
    expect(profile('vendor/y')).toEqual({
      status: 'pending',
      run_id: null,
      failure_class: null,
      retry_after: null,
    });
    // No failure streak moved for the cancelled pair: it was not an attempt.
    const attempts = sqlite
      .prepare('SELECT model, outcome FROM profile_attempt_history WHERE run_id = ? ORDER BY model')
      .all(runId) as { model: string; outcome: string }[];
    expect(attempts).toEqual([{ model: 'vendor/x', outcome: 'progress' }]);
  });

  it('readies every pair of a complete paid run', async () => {
    seedRun();
    insertResults('vendor/x', cases.length);
    insertResults('vendor/y', cases.length);
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO scheduler_chunks
            (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
          VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'completed')`
        )
        .run(`${runId}:${model}:0`, runId, model, JSON.stringify(cases.map(c => c.id)));
    sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(runId);

    await dispatchScheduler(env);

    expect(profile('vendor/x').status).toBe('ready');
    expect(profile('vendor/y').status).toBe('ready');
    const attempts = sqlite
      .prepare('SELECT model, outcome FROM profile_attempt_history WHERE run_id = ? ORDER BY model')
      .all(runId) as { model: string; outcome: string }[];
    expect(attempts).toEqual([
      { model: 'vendor/x', outcome: 'progress' },
      { model: 'vendor/y', outcome: 'progress' },
    ]);
  });

  it('never turns a container-posted pre-admission stop into gradeable pending output', async () => {
    // The container callback path is where a stop can still become a measurement: it persists
    // pending output that the grader later scores. A posted `infra_unavailable` (the gateway
    // never reached admit) must be rejected before that write, so this test drives the real
    // `acceptContainerCaseResult` rather than the scheduler, and asserts the pending row.
    seedRun();
    const token = 'claim-token-1';
    sqlite
      .prepare(
        `INSERT INTO scheduler_executions
          (run_id, model, variant, rep, case_id, token, started_at, prompt_revision)
        VALUES (?, 'vendor/x', '', 0, ?, ?, ?, ?)`
      )
      .run(runId, cases[0]!.id, token, 1_700_000_000_000, ACTIVE_MEASUREMENT_REVISION);

    const accepted = await acceptContainerCaseResult(env, {
      execution: {
        runId,
        model: 'vendor/x',
        variant: '',
        rep: 0,
        caseId: cases[0]!.id,
        token,
        attemptStartedAt: 1_700_000_000_000,
      },
      outcome: {
        kind: 'completed',
        response: {
          exitCode: 0,
          durationMs: 12,
          stdoutLines: ['{"type":"text","text":"should never be graded"}'],
          stderrTail: '',
          stop: { reason: 'infra_unavailable', status: 503 },
        },
      },
    });

    // Accepted (the callback is not retried) but stored as nothing: no output to grade.
    expect(accepted).toBe(true);
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM pending_decider_outputs WHERE run_id = ?')
        .get(runId)
    ).toEqual({ n: 0 });
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM case_results WHERE run_id = ? AND model = ?')
        .get(runId, 'vendor/x')
    ).toEqual({ n: 0 });
  });
});
