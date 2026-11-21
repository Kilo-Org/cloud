import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { ACTIVE_MEASUREMENT_REVISION, deciderCasesForRouter } from './measurement-revision';
import { BenchmarkPaidPlanError, computeEngineIdentity, startPaidRequestRun } from './run';
import { SERVING_RECONCILE_INCOMPLETE_REASON, SERVING_REUSE_CASE_MARKER } from './paid-case-store';

/**
 * A first paid request for a pool the platform has never measured — the R09 case. On real
 * migrations, the explicit confirmation is what enrolls the pair; nothing antes it.
 */
describe('first paid request for an unmeasured pair (production migrations)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let sent: unknown[];
  let providerCalls: number;
  const engineIdentity = computeEngineIdentity('decider', 'efficient');
  const cases = deciderCasesForRouter('efficient', ACTIVE_MEASUREMENT_REVISION);
  /** The efficient engine's fixed decider repetition count. */
  const REPETITIONS = 3;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('2026-01-01T00:00:00.000Z');
    // The saved config the worker refuses to fabricate: one classifier and one decider model.
    sqlite
      .prepare(
        `INSERT INTO benchmark_config
          (id, min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id,
            benchmark_org_id, updated_at)
        VALUES (1, 0.7, 3, 4, 'bot-internal-1', 'bench-org', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO config_classifier_models (router, model) VALUES ('efficient', 'vendor/classifier')"
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO config_decider_models (router, model, variant, reasoning_effort)
        VALUES ('efficient', 'vendor/alpha', NULL, NULL)`
      )
      .run();
    sent = [];
    providerCalls = 0;
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
          throw new Error('no container may start from an unconfirmed click');
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: '{"slots":2}',
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  /** Register an active request whose plan has `pairs` fully staged as queued slots. */
  /** A bitset of `bits` bits with every bit set to `value`. */
  function bitset(bits: number, value: boolean): string {
    const bytes = new Uint8Array(Math.max(1, Math.ceil(bits / 8)));
    if (value) bytes.fill(0xff);
    return Buffer.from(bytes).toString('base64');
  }

  function seedActiveRequest(
    pairs: { model: string; variant: string }[],
    options: { status?: string; serving?: readonly string[]; stage?: boolean } = {}
  ): string {
    const requestId = 'req-first';
    const at = '2026-11-20T00:00:00.000Z';
    // The launch reads the frozen plan from the quote, so the fixture must carry a real one:
    // the repetition count, the engine identity and each pair's `serving` verdict all come
    // from here, and are what the launch is compared against.
    const serving = new Set(options.serving ?? []);
    const plan = {
      version: 1,
      router: 'efficient',
      engineIdentity,
      revision: ACTIVE_MEASUREMENT_REVISION,
      repetitions: REPETITIONS,
      caseIds: cases.map(benchCase => benchCase.id),
      pairs: pairs.map(pair => ({
        model: pair.model,
        variant: pair.variant,
        serving: serving.has(pair.model),
        missing: bitset(cases.length * REPETITIONS, !serving.has(pair.model)),
        covered: bitset(cases.length * REPETITIONS, false),
        cost: cases.map(() => (serving.has(pair.model) ? 0 : 1)),
      })),
      counts: { reused: 0, covered: 0, shared: 0, exclusive: 0 },
      estimateMicrodollars: 0,
      maximumMicrodollars: 0,
      aliases: [],
      projectId: 'Auto-routing benchmarks / user / pool-one / router-1',
    };
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_quotes
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, context, plan, estimate_microdollars, maximum_microdollars,
            plan_cases, expires_at, started_request_id, created_at, updated_at)
        VALUES ('quote-first', 'user', 'user-1', NULL, 'efficient', 'router-1', 'pool-v1',
          ?, '{}', ?, 100, 100, 0, '2027-01-01T00:00:00.000Z', ?, ?, ?)`
      )
      .run(engineIdentity, JSON.stringify(plan), requestId, at, at);
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_requests
          (id, owner_type, owner_id, organization_id, router, router_id, pool_version,
            engine_identity, status, quote_id, estimate_microdollars, maximum_microdollars,
            charged_microdollars, plan_cases, staged_cases, pause_reason, actor_user_id,
            context, created_at, updated_at, activated_at)
        VALUES (?, 'user', 'user-1', NULL, 'efficient', 'router-1', 'pool-v1',
          ?, ?, 'quote-first', 100, 100, 0, ?, ?, NULL, 'user-1', '{}', ?, ?, ?)`
      )
      .run(requestId, engineIdentity, options.status ?? 'active', 0, 0, at, at, at);
    const stage = sqlite.prepare(
      `INSERT INTO paid_benchmark_request_cases
        (request_id, engine_identity, model, variant, rep, case_id, status,
          covered_by_kilo, charged_microdollars, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, NULL, ?)`
    );
    const stageRun = sqlite.prepare(
      `INSERT INTO benchmark_case_runs
        (engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 1, 0, 0, ?, ?)`
    );
    // The plan freezes its repetition count, and the engine measures efficient pools three
    // times, so a confirmed plan stages every rep 0..2 — not just rep 0.
    if (options.stage === false) return requestId;
    for (const pair of pairs.filter(candidate => !serving.has(candidate.model)))
      for (const benchCase of cases)
        for (let rep = 0; rep < REPETITIONS; rep += 1) {
          stage.run(requestId, engineIdentity, pair.model, pair.variant, rep, benchCase.id, at);
          stageRun.run(engineIdentity, pair.model, pair.variant, rep, benchCase.id, at, at);
        }
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET plan_cases = ?, staged_cases = ? WHERE id = ?')
      .run(
        pairs.length * cases.length * REPETITIONS,
        pairs.length * cases.length * REPETITIONS,
        requestId
      );
    return requestId;
  }

  function profileRow(model: string) {
    return sqlite
      .prepare(
        `SELECT status, run_id, platform_requested, user_requested FROM benchmark_profiles
        WHERE router = 'efficient' AND model = ? AND variant = '' AND engine_identity = ?
          AND repetitions = 3`
      )
      .get(model, engineIdentity) as
      | {
          status: string;
          run_id: string | null;
          platform_requested: number;
          user_requested: number;
        }
      | undefined;
  }

  function countRows(sql: string, ...params: unknown[]): number {
    const row = sqlite.prepare(sql).get(...(params as never[]));
    if (row === undefined) return 0;
    const counted = row as { n: number };
    return Number(counted.n);
  }

  function runCount(): number {
    return countRows('SELECT COUNT(*) AS n FROM benchmark_runs');
  }

  it('enrolls no pair before the click, then starts the first launch from setup alone', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);

    // Zero pre-click enrollment: staging the plan writes cases, never registry membership.
    expect(profileRow('vendor/alpha')).toBeUndefined();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 0 });

    const result = await startPaidRequestRun(env, requestId);

    // The first launch succeeds: it does not depend on a historical profile row.
    expect(result.skipped).toEqual([]);
    expect(result.claimed).toBe(1);
    expect(result.runId).toBe(`user-paid-${requestId}`);
    // The confirmation is the authorization: the row exists, is claimed by that run, and is
    // neither platform nor legacy-user demand.
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: `user-paid-${requestId}`,
      platform_requested: 0,
      user_requested: 0,
    });
    const run = sqlite
      .prepare(
        'SELECT purpose, status, engine_identity, repetitions FROM benchmark_runs WHERE id = ?'
      )
      .get(result.runId) as {
      purpose: string;
      status: string;
      engine_identity: string;
      repetitions: number;
    };
    expect(run).toEqual({
      purpose: 'user',
      status: 'running',
      engine_identity: engineIdentity,
      repetitions: 3,
    });
    // One scheduler wake was queued; no provider call and no container started.
    expect(sent).toEqual([
      { runId: result.runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true },
    ]);
    expect(providerCalls).toBe(0);
  });

  it('is idempotent: a second click reuses the run instead of enrolling another', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    await startPaidRequestRun(env, requestId);

    const again = await startPaidRequestRun(env, requestId);

    expect(again).toEqual({ runId: `user-paid-${requestId}`, claimed: 0, skipped: ['run_exists'] });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').get()).toEqual({ n: 1 });
    // Still one wake, from the first click: the retry queued nothing.
    expect(sent).toHaveLength(1);
  });

  // --- R33: the claim-then-insert crash window -----------------------------------------

  it('recovers a claim left by a crash before the run row was written', async () => {
    // The persisted checkpoint a crash leaves: the profile is claimed under this request's
    // deterministic run id, and no benchmark_runs row exists for it. This is exactly the
    // window between markProfilesRunningForRun and insertRun.
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    const runId = `user-paid-${requestId}`;
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/alpha', '', ?, 3, 'running', ?, ?, ?, 0, 0)`
      )
      .run(engineIdentity, runId, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z');

    // Exactly the persisted state: one claimed row, deterministic owner, zero runs.
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: runId,
      platform_requested: 0,
      user_requested: 0,
    });
    expect(runCount()).toBe(0);

    // Recovery needs no scheduler orphan timeout: the claim predicate accepts a row already
    // owned by this same run id, so the next activation pass reclaims and finishes the launch.
    const result = await startPaidRequestRun(env, requestId);

    expect(result).toEqual({ runId, claimed: 1, skipped: [] });
    expect(runCount()).toBe(1);
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: runId,
      platform_requested: 0,
      user_requested: 0,
    });
    // Still no provider work, and one wake for the recovered run.
    expect(sent).toEqual([{ runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true }]);
    expect(providerCalls).toBe(0);
  });

  it('releases the claim and resumes when the queue is at its cap', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    // Fill the platform-queue cap with other running runs so admission is refused.
    for (let index = 0; index < 4; index += 1)
      sqlite
        .prepare(
          `INSERT INTO benchmark_runs
            (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
              max_concurrency, repetitions, engine_identity, benchmark_user_id,
              benchmark_org_id, measurement_revision, admission_marker)
          VALUES (?, 'efficient', 'decider', 'user', 'running', '2026-11-20T01:00:00.000Z',
            0.7, 3, 0, 3, ?, 'bot-internal-1', 'bench-org', 3, 'admitted:test')`
        )
        .run(`busy-${index}`, engineIdentity);

    const result = await startPaidRequestRun(env, requestId);

    // A capped queue is not a terminal state: the claim is handed back, nothing is written,
    // and the durable confirmation lets a later pass resume.
    expect(result).toEqual({ runId: null, claimed: 0, skipped: ['queue_full'] });
    expect(runCount()).toBe(4);
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'pending',
      run_id: null,
      platform_requested: 0,
      user_requested: 0,
    });
    expect(sent).toEqual([]);
  });

  it('attaches instead of clearing the live owner when another run holds the pair', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    // A live run from someone else owns the pair.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
            max_concurrency, repetitions, engine_identity, benchmark_user_id, benchmark_org_id,
            measurement_revision, admission_marker)
        VALUES ('owner-run', 'efficient', 'decider', 'user', 'running',
          '2026-11-20T01:00:00.000Z', 0.7, 3, 0, 3, ?, 'bot-internal-1', 'bench-org', 3,
          'admitted:test')`
      )
      .run(engineIdentity);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/alpha', '', ?, 3, 'running', 'owner-run', ?, ?, 0, 0)`
      )
      .run(engineIdentity, '2026-11-20T01:00:00.000Z', '2026-11-20T01:00:00.000Z');

    const result = await startPaidRequestRun(env, requestId);

    // Attachment, not failure and not theft: the live owner keeps the row and its run id.
    expect(result).toEqual({ runId: null, claimed: 0, skipped: ['pairs_claimed'] });
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: 'owner-run',
      platform_requested: 0,
      user_requested: 0,
    });
    // No second run for this request, so the owner is never cleared or replaced.
    expect(runCount()).toBe(1);
    expect(sent).toEqual([]);
  });

  it('keeps the winner state when two launchers of one request run at once', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);

    const results = await Promise.all([
      startPaidRequestRun(env, requestId),
      startPaidRequestRun(env, requestId),
    ]);

    // Desired end state, asserted exactly: one committed run, one owned live pair, one wake.
    const runId = `user-paid-${requestId}`;
    expect(results).toEqual([
      { runId, claimed: 1, skipped: [] },
      { runId, claimed: 0, skipped: ['run_exists'] },
    ]);
    expect(runCount()).toBe(1);
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: runId,
      platform_requested: 0,
      user_requested: 0,
    });
    // The loser is idempotent: it reports the winner's run and queues nothing extra.
    expect(sent).toEqual([{ runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true }]);
    expect(providerCalls).toBe(0);
  });

  it('refuses a frozen plan whose repetition count no longer matches the engine', async () => {
    // The confirmation priced 1 repetition; the engine now runs 3. Following the live value
    // would silently re-scope and re-price approved work, so it is refused before any claim.
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    // The quote froze 1 repetition; the engine now runs 3.
    const frozenPlan = JSON.parse(
      (
        sqlite
          .prepare('SELECT plan FROM paid_benchmark_quotes WHERE id = ?')
          .get('quote-first') as {
          plan: string;
        }
      ).plan
    ) as Record<string, unknown>;
    sqlite
      .prepare('UPDATE paid_benchmark_quotes SET plan = ? WHERE id = ?')
      .run(JSON.stringify({ ...frozenPlan, repetitions: 1 }), 'quote-first');

    // A typed refusal, not a message match: callers classify by class so a deployment-wide
    // config error can never be mistaken for a permanent plan refusal.
    await expect(startPaidRequestRun(env, requestId)).rejects.toThrow(BenchmarkPaidPlanError);
    await expect(startPaidRequestRun(env, requestId)).rejects.toThrow(
      /confirmed for 1 repetitions but the engine now runs 3/
    );

    // Nothing was claimed, enrolled or dispatched: refusal happens before the claim.
    expect(runCount()).toBe(0);
    expect(profileRow('vendor/alpha')).toBeUndefined();
    expect(sent).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it('readies a fully reused pair that is not yet serving, with zero inference', async () => {
    // A frozen plan whose pair is `serving: false` but has complete historical draws across
    // every repetition. Nothing is quoted as paid, the request stages those slots as reused,
    // and activation must still publish the pair ready from the draws — no provider call.
    // Seeded with the pair listed (so the frozen plan names it, `serving: false`) but no
    // staged slots: this test stages every slot itself as `reused`.
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }], {
      serving: [],
      stage: false,
    });
    const runId = `user-paid-${requestId}`;

    // Historical measurements: a completed run of this engine with every case, every rep.
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, completed_at, min_accuracy,
            switch_cost_factor, max_concurrency, repetitions, engine_identity,
            benchmark_user_id, benchmark_org_id, measurement_revision, admission_marker)
        VALUES ('history-run', 'efficient', 'decider', 'user', 'completed',
          '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 0.7, 3, 0, 3, ?,
          'bot-internal-1', 'bench-org', ?, 'admitted:seed')`
      )
      .run(engineIdentity, ACTIVE_MEASUREMENT_REVISION);
    const insertResult = sqlite.prepare(
      `INSERT INTO case_results
        (run_id, model, variant, case_id, score, latency_ms, cost_usd, rep, timed_out,
          exit_code, prompt_revision)
      VALUES ('history-run', 'vendor/alpha', '', ?, 1, 10, 0.001, ?, 0, 0, ?)`
    );
    for (const benchCase of cases)
      for (let rep = 0; rep < REPETITIONS; rep += 1)
        insertResult.run(benchCase.id, rep, ACTIVE_MEASUREMENT_REVISION);

    // The plan froze the pair as not serving, and staged every slot as reused.
    const stage = sqlite.prepare(
      `INSERT INTO paid_benchmark_request_cases
        (request_id, engine_identity, model, variant, rep, case_id, status,
          covered_by_kilo, charged_microdollars, reason, updated_at)
      VALUES (?, ?, 'vendor/alpha', '', ?, ?, 'reused', 0, 0, NULL, ?)`
    );
    for (const benchCase of cases)
      for (let rep = 0; rep < REPETITIONS; rep += 1)
        stage.run(requestId, engineIdentity, rep, benchCase.id, '2026-11-20T00:00:00.000Z');
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET plan_cases = ?, staged_cases = ? WHERE id = ?')
      .run(cases.length * REPETITIONS, cases.length * REPETITIONS, requestId);

    // Nothing is paid, so nothing is queued: no case run, no claim row.
    expect(
      countRows('SELECT COUNT(*) AS n FROM paid_benchmark_request_cases WHERE status = ?', 'queued')
    ).toBe(0);

    const result = await startPaidRequestRun(env, requestId);

    // Activation publishes the pair from the reuse copier, not from a paid run.
    expect(result).toEqual({ runId, claimed: 1, skipped: [] });
    expect(profileRow('vendor/alpha')).toEqual({
      status: 'running',
      run_id: runId,
      platform_requested: 0,
      user_requested: 0,
    });
    // Launch itself copies nothing: the reuse pass runs in the run's initialization, which
    // the scheduler wake drives. What launch must guarantee is the run, the claim and the
    // wake — all with zero provider calls.
    expect(sent).toEqual([{ runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true }]);
    expect(providerCalls).toBe(0);
  });

  // --- R39: a frozen plan never re-measures a mature pair ------------------------------

  it('starts a run only for the unmeasured pair of a frozen plan', async () => {
    // X is mature and serving at this engine and repetition count; its measurements are
    // older (revision 2) than the active revision (3), which must NOT create new demand.
    // Y has never been measured, so the frozen plan quotes only Y.
    const requestId = seedActiveRequest(
      [
        { model: 'vendor/x', variant: '' },
        { model: 'vendor/alpha', variant: '' },
      ],
      { serving: ['vendor/x'] }
    );
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, completed_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/x', '', ?, 3, 'ready', 'mature-x-run', ?, ?, ?, 0, 0)`
      )
      .run(
        engineIdentity,
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      );
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, completed_at, min_accuracy,
            switch_cost_factor, max_concurrency, repetitions, engine_identity,
            benchmark_user_id, benchmark_org_id, measurement_revision, admission_marker)
        VALUES ('mature-x-run', 'efficient', 'decider', 'platform', 'completed',
          '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 0.7, 3, 0, 3, ?,
          'bot-internal-1', 'bench-org', 2, 'admitted:seed')`
      )
      .run(engineIdentity);

    // The plan froze both pairs, but only Y is a paid slot: X is serving.
    // X is serving: its slots are staged `reused`, never queued for measurement.
    const stageServing = sqlite.prepare(
      `INSERT INTO paid_benchmark_request_cases
        (request_id, engine_identity, model, variant, rep, case_id, status,
          covered_by_kilo, charged_microdollars, reason, updated_at)
      VALUES (?, ?, 'vendor/x', '', ?, ?, 'reused', 0, 0, NULL, ?)`
    );
    for (const benchCase of cases)
      for (let rep = 0; rep < REPETITIONS; rep += 1)
        stageServing.run(requestId, engineIdentity, rep, benchCase.id, '2026-11-20T00:00:00.000Z');
    sqlite
      .prepare('UPDATE paid_benchmark_requests SET plan_cases = ?, staged_cases = ? WHERE id = ?')
      .run(cases.length * REPETITIONS * 2, cases.length * REPETITIONS * 2, requestId);

    const before = profileRow('vendor/x');
    const result = await startPaidRequestRun(env, requestId);

    // Only Y is claimed and planned; X contributes no claim and no re-measure.
    expect(result).toEqual({ runId: `user-paid-${requestId}`, claimed: 1, skipped: [] });
    expect(profileRow('vendor/x')).toEqual(before!);
    expect(
      countRows('SELECT COUNT(*) AS n FROM profile_remeasures WHERE run_id = ?', result.runId)
    ).toBe(0);
    const models = sqlite
      .prepare('SELECT model FROM run_models WHERE run_id = ? ORDER BY model')
      .all(result.runId!) as { model: string }[];
    expect(models).toEqual([{ model: 'vendor/alpha' }]);
    expect(providerCalls).toBe(0);
  });

  it('reuses a pair that became ready after the quote instead of remeasuring it', async () => {
    // The freeze happens at quote time. Here the quote priced BOTH pairs as unmeasured, then
    // `vendor/x` became ready (revision 2) before the click. A stale ready profile already
    // ranks X, so remeasuring it — including the revision-3 probe cases — would bill the owner
    // for a pair that serves. X must be reused from that evidence; only Y is measured.
    const requestId = seedActiveRequest([
      { model: 'vendor/x', variant: '' },
      { model: 'vendor/alpha', variant: '' },
    ]);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, completed_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/x', '', ?, 3, 'ready', 'mature-x-run', ?, ?, ?, 0, 0)`
      )
      .run(
        engineIdentity,
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      );
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, completed_at, min_accuracy,
            switch_cost_factor, max_concurrency, repetitions, engine_identity,
            benchmark_user_id, benchmark_org_id, measurement_revision, admission_marker)
        VALUES ('mature-x-run', 'efficient', 'decider', 'user', 'completed',
          '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 0.7, 3, 0, 3, ?,
          'bot-internal-1', 'bench-org', 2, 'admitted:seed')`
      )
      .run(engineIdentity);

    const before = profileRow('vendor/x');
    const result = await startPaidRequestRun(env, requestId);

    // Only Y is claimed; X contributes no claim and no re-measure, and its profile stands.
    expect(result).toEqual({ runId: `user-paid-${requestId}`, claimed: 1, skipped: [] });
    expect(profileRow('vendor/x')).toEqual(before!);
    expect(
      countRows('SELECT COUNT(*) AS n FROM profile_remeasures WHERE run_id = ?', result.runId)
    ).toBe(0);
    expect(
      countRows('SELECT COUNT(*) AS n FROM profile_remeasures WHERE model = ?', 'vendor/x')
    ).toBe(0);
    expect(
      sqlite
        .prepare('SELECT model FROM run_models WHERE run_id = ? ORDER BY model')
        .all(result.runId!)
    ).toEqual([{ model: 'vendor/alpha' }]);
    // X's own staged rows are now reuse evidence, not live work: nothing waits on them.
    expect(
      countRows(
        `SELECT COUNT(*) AS n FROM paid_benchmark_request_cases
        WHERE request_id = ? AND model = 'vendor/x' AND status IN ('queued', 'running')`,
        requestId
      )
    ).toBe(0);
    expect(
      countRows(
        `SELECT COUNT(*) AS n FROM paid_benchmark_request_cases
        WHERE request_id = ? AND model = 'vendor/x' AND status = 'reused'`,
        requestId
      )
    ).toBe(cases.length * REPETITIONS);
    // Y still launches independently, and nothing reaches a provider from a launch.
    expect(sent).toEqual([
      { runId: result.runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true },
    ]);
    expect(providerCalls).toBe(0);
  });

  it('completes a fully now-ready request with its pin intent and starts no run', async () => {
    // Both pairs were quoted unmeasured and both became ready before the click. There is no
    // work left, so the request completes in the launch batch together with the durable pin
    // intent the outbox drain delivers — never a run, a claim or a provider call.
    const requestId = seedActiveRequest([
      { model: 'vendor/x', variant: '' },
      { model: 'vendor/alpha', variant: '' },
    ]);
    for (const model of ['vendor/x', 'vendor/alpha'])
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles
            (router, model, variant, engine_identity, repetitions, status, run_id,
              requested_at, updated_at, completed_at, platform_requested, user_requested)
          VALUES ('efficient', ?, '', ?, 3, 'ready', ?, ?, ?, ?, 0, 0)`
        )
        .run(
          model,
          engineIdentity,
          `mature-${model}`,
          '2026-10-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z',
          '2026-10-01T00:00:00.000Z'
        );

    const result = await startPaidRequestRun(env, requestId);

    expect(result).toEqual({ runId: null, claimed: 0, skipped: ['already_ready'] });
    expect(runCount()).toBe(0);
    expect(sent).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(
      sqlite.prepare('SELECT status FROM paid_benchmark_requests WHERE id = ?').get(requestId)
    ).toEqual({ status: 'completed' });
    expect(
      sqlite.prepare('SELECT id, kind, status FROM paid_benchmark_billing_outbox').all()
    ).toEqual([{ id: `pins:${requestId}`, kind: 'pins', status: 'pending' }]);
    // No display row is left live.
    expect(
      countRows(
        `SELECT COUNT(*) AS n FROM paid_benchmark_request_cases
        WHERE request_id = ? AND status IN ('queued', 'running')`,
        requestId
      )
    ).toBe(0);
  });

  it('does not measure a pair whose serving reuse already committed, after it stops being ready', async () => {
    // The crash-after-success window: a prior activation reconciled X to `reused` and died
    // before claiming Y. X's profile is withdrawn before the retry, so a registry re-read
    // would call X never-ready and measure it — spend the request already decided against.
    // The committed display rows are the durable authority.
    const requestId = seedActiveRequest([
      { model: 'vendor/x', variant: '' },
      { model: 'vendor/alpha', variant: '' },
    ]);
    // X's every row was converted by an earlier serving reconcile: `reused` plus the marker.
    sqlite
      .prepare(
        `UPDATE paid_benchmark_request_cases SET status = 'reused', reason = ?
        WHERE request_id = ? AND model = 'vendor/x'`
      )
      .run(SERVING_REUSE_CASE_MARKER, requestId);
    // ...and its serving evidence is gone.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/x', '', ?, 3, 'pending', NULL, ?, ?, 0, 0)`
      )
      .run(engineIdentity, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

    const result = await startPaidRequestRun(env, requestId);

    // Only the sibling is measured; X is neither claimed nor remeasured.
    expect(result).toEqual({ runId: `user-paid-${requestId}`, claimed: 1, skipped: [] });
    expect(
      countRows('SELECT COUNT(*) AS n FROM profile_remeasures WHERE model = ?', 'vendor/x')
    ).toBe(0);
    expect(
      sqlite
        .prepare('SELECT model FROM run_models WHERE run_id = ? ORDER BY model')
        .all(result.runId!)
    ).toEqual([{ model: 'vendor/alpha' }]);
    expect(
      sqlite
        .prepare(
          `SELECT status, run_id FROM benchmark_profiles
          WHERE model = 'vendor/x' AND variant = '' AND engine_identity = ? AND repetitions = 3`
        )
        .get(engineIdentity)
    ).toEqual({ status: 'pending', run_id: null });
    expect(sent).toEqual([
      { runId: result.runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true },
    ]);
    expect(providerCalls).toBe(0);
  });

  it('still launches zero-provider materialization for an all-historically-reused pair', async () => {
    // Ordinary historical reuse (paid-benchmark.ts stages every draw `reused` with no marker)
    // is NOT a serving decision: the pair has no ready profile yet, so the launch must claim
    // it and let the reuse copier ready it with zero provider calls. Only the serving marker
    // may suppress that, or shared activation would silently stop working.
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }]);
    sqlite
      .prepare(
        `UPDATE paid_benchmark_request_cases SET status = 'reused', reason = NULL
        WHERE request_id = ?`
      )
      .run(requestId);

    const result = await startPaidRequestRun(env, requestId);

    expect(result).toEqual({ runId: `user-paid-${requestId}`, claimed: 1, skipped: [] });
    expect(
      sqlite.prepare('SELECT model FROM run_models WHERE run_id = ?').all(result.runId!)
    ).toEqual([{ model: 'vendor/alpha' }]);
    expect(sent).toEqual([
      { runId: result.runId, kind: 'decider', model: 'vendor/alpha', schedulerWake: true },
    ]);
    expect(providerCalls).toBe(0);
  });

  it('durably fails when readiness withdrew, and a second activation cannot launch', async () => {
    // The launch reads readiness, then reconciles. If the serving profile is withdrawn in
    // that window, the reconcile cannot move this request's rows. The pair's lifecycle is
    // therefore unproven, and inserting a remeasure would be fail-open spend — worse, a JS-only
    // deferral would let the NEXT activation see the pair as never-ready and measure it. The
    // guard closes the request in the reconcile batch itself, so nothing can re-enter.
    const requestId = seedActiveRequest([
      { model: 'vendor/x', variant: '' },
      { model: 'vendor/alpha', variant: '' },
    ]);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles
          (router, model, variant, engine_identity, repetitions, status, run_id,
            requested_at, updated_at, completed_at, platform_requested, user_requested)
        VALUES ('efficient', 'vendor/x', '', ?, 3, 'ready', 'mature-x-run', ?, ?, ?, 0, 0)`
      )
      .run(
        engineIdentity,
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      );

    // Withdraw the serving evidence exactly between the launch's readiness read and its
    // reconcile: the wrapper runs the withdrawal the first time the reconcile SQL is prepared.
    const reconcileSql = `SET status = 'reused', reason = ?`;
    const baseDb = sqliteD1(sqlite);
    let withdrew = false;
    const db = {
      prepare(sqlText: string) {
        if (sqlText.includes(reconcileSql) && !withdrew) {
          withdrew = true;
          sqlite
            .prepare(
              "UPDATE benchmark_profiles SET status = 'pending', run_id = NULL WHERE model = 'vendor/x'"
            )
            .run();
        }
        return baseDb.prepare(sqlText);
      },
      batch(statements: D1PreparedStatement[]) {
        return baseDb.batch(statements);
      },
      exec(sqlText: string) {
        return baseDb.exec(sqlText);
      },
    } as unknown as D1Database;
    const envWithHook = { ...env, BENCH_DB: db } as unknown as Env;

    const result = await startPaidRequestRun(envWithHook, requestId);

    // The request is terminally failed with a retryable, fresh-estimate reason.
    expect(result).toEqual({ runId: null, claimed: 0, skipped: ['request_not_active'] });
    const requestRow = sqlite
      .prepare(
        'SELECT status, failure_reason, failure_retryable FROM paid_benchmark_requests WHERE id = ?'
      )
      .get(requestId);
    expect(requestRow).toEqual({
      status: 'failed',
      failure_reason: SERVING_RECONCILE_INCOMPLETE_REASON,
      failure_retryable: 1,
    });
    // No remeasure, no enrollment, no run, no provider, and no live display row left.
    expect(
      countRows('SELECT COUNT(*) AS n FROM profile_remeasures WHERE model = ?', 'vendor/x')
    ).toBe(0);
    expect(runCount()).toBe(0);
    expect(sent).toEqual([]);
    expect(providerCalls).toBe(0);
    expect(
      countRows(
        `SELECT COUNT(*) AS n FROM paid_benchmark_request_cases
        WHERE request_id = ? AND status IN ('queued', 'running')`,
        requestId
      )
    ).toBe(0);

    // The durable state is the fence: a second activation cannot launch the pair either.
    const second = await startPaidRequestRun(env, requestId);
    expect(second).toEqual({ runId: null, claimed: 0, skipped: ['request_not_active'] });
    expect(runCount()).toBe(0);
    expect(sent).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  it('enrolls nothing for a request that is not active', async () => {
    const requestId = seedActiveRequest([{ model: 'vendor/alpha', variant: '' }], {
      status: 'preparing',
    });

    const result = await startPaidRequestRun(env, requestId);

    expect(result).toEqual({ runId: null, claimed: 0, skipped: ['request_not_active'] });
    expect(profileRow('vendor/alpha')).toBeUndefined();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_runs').get()).toEqual({ n: 0 });
    expect(sent).toEqual([]);
  });
});
