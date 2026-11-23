import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  acquireAliasPromotionLease,
  releaseAliasPromotionLease,
  ALIAS_READINESS_LEASE_ID,
} from './alias-promotion';
import { aliasReadinessLeaseHeld, markProfilesReadyForRun, settleRemeasuresForRun } from './db';
import { ALIAS_READINESS_CLEAR_SQL } from './alias-readiness-lease';
import { ACTIVE_MEASUREMENT_REVISION, deciderCasesForRouter } from './measurement-revision';
import { markSettledRunInitialized } from './scheduler';
import { computeEngineIdentity, dispatchScheduler } from './run';

/**
 * The alias readiness lease against real finalization. A held lease must make every ready
 * publication a no-op that leaves the run open, and the sweep must finish the same whole run
 * once the lease is gone. Nothing here may strand a claim or record a failure.
 */
describe('alias readiness lease fence (production migrations)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
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
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: { async send() {} },
      BENCH_RUNNER: {
        idFromName: (name: string) => name,
        get: () => {
          throw new Error('finalization must not start a container');
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: '{"slots":2}',
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedSettledRun({
    marker = true,
    purpose = 'user',
  }: { marker?: boolean; purpose?: 'user' | 'platform' } = {}) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs
          (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
            max_concurrency, repetitions, engine_identity, benchmark_user_id,
            benchmark_org_id, measurement_revision, admission_marker)
        VALUES (?, 'efficient', 'decider', ?, 'running', ?, 0.7, 3, 0, 3, ?,
          'bot-internal-1', 'bench-org', ?, 'admitted:test')`
      )
      .run(runId, purpose, NOW, engineIdentity, ACTIVE_MEASUREMENT_REVISION);
    const profile = sqlite.prepare(
      `INSERT INTO benchmark_profiles
        (router, model, variant, engine_identity, repetitions, status, run_id,
          requested_at, updated_at, platform_requested, user_requested)
      VALUES ('efficient', ?, '', ?, 3, 'running', ?, ?, ?, ?, ?)`
    );
    const result = sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, cost_usd,
        rep, timed_out, exit_code, prompt_revision)
      VALUES (?, ?, '', ?, 1, 10, 0.01, ?, 0, 0, ?)`
    );
    const chunk = sqlite.prepare(
      `INSERT INTO scheduler_chunks
        (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
      VALUES (?, ?, ?, '', '[]', 0, 0, ?, 'completed')`
    );
    for (const model of ['vendor/x', 'vendor/y']) {
      sqlite
        .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
        .run(runId, model);
      profile.run(
        model,
        engineIdentity,
        runId,
        NOW,
        NOW,
        purpose === 'platform' ? 1 : 0,
        purpose === 'user' ? 1 : 0
      );
      for (const benchCase of cases)
        for (let rep = 0; rep < 3; rep += 1)
          result.run(runId, model, benchCase.id, rep, ACTIVE_MEASUREMENT_REVISION);
      chunk.run(`${runId}:${model}:0`, runId, model, JSON.stringify(cases.map(c => c.id)));
    }
    if (marker) sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(runId);
  }

  function profiles() {
    return sqlite
      .prepare(
        `SELECT model, status, run_id FROM benchmark_profiles
        WHERE router = 'efficient' AND variant = '' AND engine_identity = ? AND repetitions = 3
        ORDER BY model`
      )
      .all(engineIdentity) as { model: string; status: string; run_id: string | null }[];
  }

  function runStatus(): string {
    const row = sqlite.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(runId);
    return String(row?.status);
  }

  function attempts(): { model: string; outcome: string }[] {
    return sqlite
      .prepare('SELECT model, outcome FROM profile_attempt_history WHERE run_id = ? ORDER BY model')
      .all(runId) as { model: string; outcome: string }[];
  }

  it('defers readiness while the lease is held and finishes the whole run after release', async () => {
    seedSettledRun();
    const token = 'promotion-1';
    const acquired = await acquireAliasPromotionLease(env.BENCH_DB, token, [], []);
    expect(acquired.status).toBe('held');
    expect(await aliasReadinessLeaseHeld(env.BENCH_DB)).toBe(true);

    await dispatchScheduler(env);

    // Nothing was published and nothing became terminal: the run and both claims survive.
    expect(runStatus()).toBe('running');
    expect(profiles()).toEqual([
      { model: 'vendor/x', status: 'running', run_id: runId },
      { model: 'vendor/y', status: 'running', run_id: runId },
    ]);
    // Finalization really reached its publication step — the attempt records exist — so the
    // result above is a deferred publication, not a function that returned before settling.
    expect(attempts()).toEqual([
      { model: 'vendor/x', outcome: 'progress' },
      { model: 'vendor/y', outcome: 'progress' },
    ]);
    // No failure streak moved: a temporary lease is never a failed attempt.
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM run_lane_failures WHERE run_id = ?').get(runId)
    ).toEqual({ n: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM benchmark_profiles
          WHERE run_id = ? AND failure_attempts > 0`
        )
        .get(runId)
    ).toEqual({ n: 0 });

    // A second pass under the same lease still publishes nothing and reaches no completion.
    await dispatchScheduler(env);
    expect(runStatus()).toBe('running');
    expect(profiles().map(row => row.status)).toEqual(['running', 'running']);

    await releaseAliasPromotionLease(env.BENCH_DB, token);
    expect(await aliasReadinessLeaseHeld(env.BENCH_DB)).toBe(false);

    await dispatchScheduler(env);

    expect(runStatus()).toBe('completed');
    expect(profiles()).toEqual([
      { model: 'vendor/x', status: 'ready', run_id: runId },
      { model: 'vendor/y', status: 'ready', run_id: runId },
    ]);
    expect(attempts()).toEqual([
      { model: 'vendor/x', outcome: 'progress' },
      { model: 'vendor/y', outcome: 'progress' },
    ]);
  });

  it('keeps a run out of a terminal status while the lease defers its only publication', async () => {
    seedSettledRun();
    await acquireAliasPromotionLease(env.BENCH_DB, 'promotion-2', [], []);

    const outcome = await markProfilesReadyForRun(env.BENCH_DB, runId);
    expect(outcome).toBe('deferred');
    expect(profiles().map(row => row.status)).toEqual(['running', 'running']);

    await releaseAliasPromotionLease(env.BENCH_DB, 'promotion-2');
    expect(await markProfilesReadyForRun(env.BENCH_DB, runId)).toBe('published');
    expect(profiles().map(row => row.status)).toEqual(['ready', 'ready']);
  });

  it('ignores an expired lease and a released row', async () => {
    seedSettledRun();
    // An expired lease is one nobody holds: the guard reads the database clock, so a stale
    // deadline can never wedge publication.
    sqlite
      .prepare(`INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (?, ?, ?)`)
      .run(ALIAS_READINESS_LEASE_ID, 'stale', 1);
    expect(await aliasReadinessLeaseHeld(env.BENCH_DB)).toBe(false);
    expect(await markProfilesReadyForRun(env.BENCH_DB, runId)).toBe('published');

    sqlite
      .prepare('UPDATE benchmark_profiles SET status = ? WHERE run_id = ?')
      .run('running', runId);
    await acquireAliasPromotionLease(env.BENCH_DB, 'promotion-3', [], []);
    await releaseAliasPromotionLease(env.BENCH_DB, 'promotion-3');
    expect(await markProfilesReadyForRun(env.BENCH_DB, runId)).toBe('published');
  });

  it('publishes a mixed failed+successful batch all-or-none from one sampled cutoff', async () => {
    // The hole this guards: reading `unixepoch` inside each statement lets the failed entry's
    // delete run while row 4 is live and the provenance update run after it expires, so a dead
    // entry's re-measure is published as ready. The guard binds one sampled cutoff (`?1`)
    // instead, and no statement may read the database clock itself.
    expect(ALIAS_READINESS_CLEAR_SQL).toContain('?1');
    expect(ALIAS_READINESS_CLEAR_SQL).not.toContain('unixepoch');

    seedSettledRun();
    // A dead entry's claim and the live success's provenance both sit in this publication. The
    // profiles must carry a DIFFERENT measuring run first: with `run_id = runId` already, a
    // provenance "move" to this run is a no-op and the assertion below could never fail.
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO profile_remeasures
            (router, model, variant, engine_identity, repetitions, run_id, requested_at, claimed_at)
          VALUES ('efficient', ?, '', ?, 3, ?, ?, ?)`
        )
        .run(model, engineIdentity, runId, NOW, NOW);
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'ready', run_id = 'prior-run' WHERE run_id = ?"
      )
      .run(runId);
    // An already-expired lease admits the whole batch: both the failed claim's delete and the
    // provenance move land, never one without the other.
    const nowMs = Number(
      sqlite.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms").get()?.now_ms
    );
    sqlite
      .prepare('INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (?, ?, ?)')
      .run(ALIAS_READINESS_LEASE_ID, 'expired', nowMs - 60_000);

    const outcome = await settleRemeasuresForRun(env.BENCH_DB, runId, [
      { model: 'vendor/y', variant: '' },
    ]);

    expect(outcome).toBe('published');
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM profile_remeasures WHERE run_id = ? AND model = 'vendor/y'"
        )
        .get(runId)
    ).toEqual({ n: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM benchmark_profiles WHERE model = 'vendor/x' AND run_id = ?"
        )
        .get(runId)
    ).toEqual({ n: 1 });
  });

  it('never lets a failed claim survive a published provenance move', async () => {
    // Held lease, so the publication must defer: neither the failed entry's claim delete nor
    // the ready provenance move may run. This is the direction where a per-statement clock
    // would have deleted the claim first and then skipped the update.
    seedSettledRun();
    await acquireAliasPromotionLease(env.BENCH_DB, 'promotion-batch', [], []);
    for (const model of ['vendor/x', 'vendor/y'])
      sqlite
        .prepare(
          `INSERT INTO profile_remeasures
            (router, model, variant, engine_identity, repetitions, run_id, requested_at, claimed_at)
          VALUES ('efficient', ?, '', ?, 3, ?, ?, ?)`
        )
        .run(model, engineIdentity, runId, NOW, NOW);
    // A deferred publication must leave the provenance where it was — not move it to this run.
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'ready', run_id = 'prior-run' WHERE run_id = ?"
      )
      .run(runId);

    const outcome = await settleRemeasuresForRun(env.BENCH_DB, runId, [
      { model: 'vendor/y', variant: '' },
    ]);

    expect(outcome).toBe('deferred');
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM profile_remeasures WHERE run_id = ?').get(runId)
    ).toEqual({ n: 2 });
    // Still on the previous measuring run: neither the failed claim's delete nor the move ran.
    expect(
      sqlite.prepare("SELECT run_id FROM benchmark_profiles WHERE model = 'vendor/x'").get()
    ).toEqual({ run_id: 'prior-run' });
  });

  it('marks only an already-settled run so the sweep can retry its finalization', async () => {
    // Finalization only runs for a decider run that already has a `scheduler_runs` marker, so
    // the sweep sees it. This helper is the deferral's guarantee that the invariant holds: it
    // records the marker for a settled run and refuses one that still has live chunks.
    seedSettledRun();
    sqlite.prepare('DELETE FROM scheduler_runs WHERE run_id = ?').run(runId);
    await markSettledRunInitialized(env.BENCH_DB, runId);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_runs WHERE run_id = ?').get(runId)
    ).toEqual({ n: 1 });

    await markSettledRunInitialized(env.BENCH_DB, runId);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_runs').get()).toEqual({ n: 1 });

    sqlite.prepare('DELETE FROM scheduler_runs WHERE run_id = ?').run(runId);
    sqlite.prepare("UPDATE scheduler_chunks SET status = 'pending' WHERE run_id = ?").run(runId);
    await markSettledRunInitialized(env.BENCH_DB, runId);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_runs WHERE run_id = ?').get(runId)
    ).toEqual({ n: 0 });
  });

  it('never completes the run on the same pass that defers its publication', async () => {
    // The regression the lease exists to prevent: an early `markRunCompleted` would settle the
    // run over a publication that wrote nothing, and no sweep would ever retry it. The run
    // must stay `running` while the lease blocks, and only the pass that publishes may finish it.
    seedSettledRun();
    await acquireAliasPromotionLease(env.BENCH_DB, 'promotion-5', [], []);

    await dispatchScheduler(env);

    expect(runStatus()).toBe('running');
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM benchmark_runs WHERE id = ? AND completed_at IS NOT NULL'
        )
        .get(runId)
    ).toEqual({ n: 0 });
    expect(profiles().map(row => row.status)).toEqual(['running', 'running']);

    await releaseAliasPromotionLease(env.BENCH_DB, 'promotion-5');
    await dispatchScheduler(env);

    expect(runStatus()).toBe('completed');
  });

  it('keeps a deferred run open when the deferral marker write fails', async () => {
    // A deferred publication writes nothing, so the run must stay open for the settled-run sweep
    // to retry the whole finalization. Recording that state is one more write, and a D1 statement
    // can fail even when it would have changed no row (the marker insert is idempotent). Falling
    // through to completion there would settle the run over a measurement that never became
    // ready — while the sweep only looks at *running* runs, so nothing would ever retry it. This
    // is the platform finalization path, where that marker write has no surrounding catch.
    seedSettledRun({ purpose: 'platform' });
    await acquireAliasPromotionLease(env.BENCH_DB, 'promotion-6', [], []);

    const baseDb = sqliteD1(sqlite);
    let markerWrites = 0;
    let faulted = false;
    const db = {
      prepare(sqlText: string) {
        const statement = baseDb.prepare(sqlText);
        // Fault exactly the first marker write; every later write and every other statement
        // reaches the real adapter unchanged — it only recognizes the statements it made itself.
        if (!sqlText.includes('INSERT INTO scheduler_runs')) return statement;
        return {
          ...statement,
          bind(...values: unknown[]) {
            const bound = statement.bind(...(values as never[]));
            if (faulted) return bound;
            faulted = true;
            return {
              ...bound,
              run: async () => {
                markerWrites += 1;
                throw new Error('D1_ERROR: scheduler marker write failed');
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch(statements: D1PreparedStatement[]) {
        return baseDb.batch(statements);
      },
      exec(sqlText: string) {
        return baseDb.exec(sqlText);
      },
    } as unknown as D1Database;

    await dispatchScheduler({ ...env, BENCH_DB: db } as unknown as Env);

    // The attempt records prove finalization really reached its publication step, so this is the
    // deferral's marker write failing — not a pass that returned before settling anything.
    expect(attempts()).toEqual([
      { model: 'vendor/x', outcome: 'progress' },
      { model: 'vendor/y', outcome: 'progress' },
    ]);
    expect(markerWrites).toBe(1);
    expect(runStatus()).toBe('running');
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM benchmark_runs WHERE id = ? AND completed_at IS NOT NULL'
        )
        .get(runId)
    ).toEqual({ n: 0 });
    expect(profiles().map(row => row.status)).toEqual(['running', 'running']);

    // The run's scheduler marker is still there and the next pass retries the same publication.
    await releaseAliasPromotionLease(env.BENCH_DB, 'promotion-6');
    await dispatchScheduler(env);

    expect(runStatus()).toBe('completed');
    expect(profiles()).toEqual([
      { model: 'vendor/x', status: 'ready', run_id: runId },
      { model: 'vendor/y', status: 'ready', run_id: runId },
    ]);
  });
});
