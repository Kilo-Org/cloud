import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  failOrphanedRunningProfiles,
  failPendingProfiles,
  listCurrentFailedProfiles,
  markProfilesFailedForEntries,
  markProfilesReadyForRun,
  markProfilesRunningForRun,
  recordLaneFailure,
  requeueRetryableCurrentProfiles,
} from './db';
import { DECIDER_CASES } from './datasets/decider-cases';
import { BenchmarkModelCatalogSchema } from './platform-models';
import {
  PROFILE_FAILURE_BUDGET,
  PROFILE_MODEL_FAILURE_BUDGET,
  unsupportedRejection,
  type ProfileFailure,
} from './profile-failure';
import { refreshCurrentProfiles } from './profile-refresh';
import { computeEngineIdentity, dispatchScheduler } from './run';
import {
  claimScheduledChunks,
  cooldownCatalog,
  deferCatalogChunk,
  scheduleRunChunks,
  schedulerConfig,
  startChunk,
} from './scheduler';

const HOUR = 3600_000;
const T0 = Date.parse('2026-11-20T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const current = { router: 'efficient' as const, engineIdentity: 'engine-test', repetitions: 1 };
const pair = { model: 'vendor/model', variant: null };

const providerDown: ProfileFailure = {
  failureClass: 'provider_unavailable',
  reason: 'Benchmark lane did not finish.',
};
const ambiguous: ProfileFailure = {
  failureClass: 'ambiguous_execution',
  reason: 'Benchmark lane did not finish.',
};

type StoredProfile = {
  status: string;
  failure_class: string | null;
  failure_attempts: number;
  model_failure_attempts: number;
  first_failed_at: string | null;
  retry_after: string | null;
  failure_reason: string | null;
};

describe('profile failure transitions (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, requested_at, updated_at, platform_requested, user_requested)
         VALUES ('efficient', ?, '', ?, 1, 'pending', ?, ?, 1, 0)`
      )
      .run(pair.model, current.engineIdentity, iso(T0), iso(T0));
  });

  afterEach(() => sqlite.close());

  function stored(): StoredProfile {
    const row = sqlite
      .prepare(
        `SELECT status, failure_class, failure_attempts, model_failure_attempts, first_failed_at,
          retry_after, failure_reason FROM benchmark_profiles WHERE model = ?`
      )
      .get(pair.model);
    if (!row) throw new Error('Missing profile row');
    return row as StoredProfile;
  }

  async function failedRun(runId: string, failure: ProfileFailure, at: number) {
    expect(await markProfilesRunningForRun(db, runId, [pair], current, iso(at))).toEqual([pair]);
    await markProfilesFailedForEntries(
      db,
      runId,
      [{ model: pair.model, variant: '' }],
      failure,
      iso(at)
    );
  }

  async function requeue(at: number) {
    return requeueRetryableCurrentProfiles(db, current, 'both', iso(at));
  }

  it.each<ProfileFailure>([
    { failureClass: 'model_not_found', reason: 'Exact model unavailable.' },
    { failureClass: 'unsupported', reason: '576 of 576 measured cases failed the same way.' },
  ])('fails $failureClass permanently on the first run', async failure => {
    await failedRun('run-1', failure, T0);
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_class: failure.failureClass,
      failure_attempts: 1,
      first_failed_at: iso(T0),
      retry_after: null,
    });
    expect(await requeue(T0 + 48 * HOUR)).toBe(0);
    expect(stored().status).toBe('unavailable');
    expect((await listCurrentFailedProfiles(db, current))[0]?.failure).toEqual({
      kind: 'permanent',
      failureClass: failure.failureClass,
      reason: failure.reason,
      attempts: 1,
      firstFailedAt: iso(T0),
      lastFailedAt: iso(T0),
      cause: 'terminal_class',
    });
  });

  it('fails a pending pair the catalog cannot run permanently before any run', async () => {
    await failPendingProfiles(
      db,
      current,
      [
        {
          model: pair.model,
          variant: '',
          failure: { failureClass: 'catalog_absent', reason: 'Not in the catalog.' },
        },
      ],
      iso(T0)
    );
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_class: 'catalog_absent',
      failure_attempts: 1,
    });
    expect(await requeue(T0 + 48 * HOUR)).toBe(0);
  });

  it('retries a model-transient failure only after its backoff and stops at the model budget', async () => {
    await failedRun('run-1', providerDown, T0);
    expect(stored()).toMatchObject({
      status: 'failed',
      failure_attempts: 1,
      model_failure_attempts: 1,
      retry_after: iso(T0 + HOUR),
    });
    expect(await requeue(T0 + HOUR / 2)).toBe(0);
    expect(stored().status).toBe('failed');
    expect(await requeue(T0 + HOUR)).toBe(1);
    expect(stored()).toMatchObject({
      status: 'pending',
      failure_class: 'provider_unavailable',
      failure_attempts: 1,
      first_failed_at: iso(T0),
      retry_after: null,
    });

    await failedRun('run-2', providerDown, T0 + 2 * HOUR);
    expect(stored()).toMatchObject({
      status: 'failed',
      failure_attempts: 2,
      first_failed_at: iso(T0),
      retry_after: iso(T0 + 4 * HOUR),
    });
    expect(await requeue(T0 + 4 * HOUR)).toBe(1);

    await failedRun('run-3', providerDown, T0 + 5 * HOUR);
    expect(PROFILE_MODEL_FAILURE_BUDGET).toBe(3);
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_attempts: 3,
      model_failure_attempts: 3,
      retry_after: null,
    });
    expect(await requeue(T0 + 100 * HOUR)).toBe(0);
    expect((await listCurrentFailedProfiles(db, current))[0]?.failure).toMatchObject({
      kind: 'permanent',
      cause: 'model_budget_exhausted',
      attempts: 3,
      firstFailedAt: iso(T0),
      lastFailedAt: iso(T0 + 5 * HOUR),
    });
  });

  it('never charges infrastructure failures to the model, but ends them at the overall budget', async () => {
    let at = T0;
    const failures = [providerDown, providerDown, ambiguous, ambiguous];
    for (const [index, failure] of failures.entries()) {
      await failedRun(`run-${index}`, failure, at);
      expect(stored().status).toBe('failed');
      at += 48 * HOUR;
      expect(await requeue(at)).toBe(1);
    }
    expect(stored()).toMatchObject({ failure_attempts: 4, model_failure_attempts: 2 });

    await failedRun('run-last', ambiguous, at);
    expect(PROFILE_FAILURE_BUDGET).toBe(5);
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_class: 'ambiguous_execution',
      failure_attempts: 5,
      model_failure_attempts: 2,
    });
    expect((await listCurrentFailedProfiles(db, current))[0]?.failure).toMatchObject({
      kind: 'permanent',
      cause: 'infrastructure_budget_exhausted',
    });
  });

  it('counts an orphaned claim as a retryable infrastructure failure', async () => {
    expect(await markProfilesRunningForRun(db, 'gone-run', [pair], current, iso(T0))).toEqual([
      pair,
    ]);
    expect(
      await failOrphanedRunningProfiles(db, 'Run ended unsettled.', iso(T0 + 1), iso(T0 + 1))
    ).toBe(1);
    expect(stored()).toMatchObject({
      status: 'failed',
      failure_class: 'orphaned_claim',
      failure_attempts: 1,
      model_failure_attempts: 0,
    });
  });

  it('clears the failure history when a run measures the pair', async () => {
    await failedRun('run-1', providerDown, T0);
    await requeue(T0 + HOUR);
    await failedRun('run-2', providerDown, T0 + 2 * HOUR);
    await requeue(T0 + 10 * HOUR);
    await markProfilesRunningForRun(db, 'run-3', [pair], current, iso(T0 + 11 * HOUR));
    await markProfilesReadyForRun(db, 'run-3', iso(T0 + 12 * HOUR));
    expect(stored()).toEqual({
      status: 'ready',
      failure_class: null,
      failure_attempts: 0,
      model_failure_attempts: 0,
      first_failed_at: null,
      retry_after: null,
      failure_reason: null,
    });
    expect(await listCurrentFailedProfiles(db, current)).toEqual([]);
  });

  const refresh = (catalog: unknown, at: number) =>
    refreshCurrentProfiles(
      db,
      { ...current, entries: [pair], mode: 'refresh' },
      BenchmarkModelCatalogSchema.parse(catalog),
      iso(at)
    );

  it('re-admits one permanent pair with a clean history when the catalog has it', async () => {
    await failedRun('run-1', { failureClass: 'model_not_found', reason: 'gone' }, T0);
    expect(await refresh({ data: [{ id: pair.model }] }, T0 + 2 * HOUR)).toEqual({
      refreshed: [pair],
      unavailable: [],
      skipped: [],
    });
    expect(stored()).toEqual({
      status: 'pending',
      failure_class: null,
      failure_attempts: 0,
      model_failure_attempts: 0,
      first_failed_at: null,
      retry_after: null,
      failure_reason: null,
    });
  });

  it.each<ProfileFailure>([
    { failureClass: 'model_not_found', reason: 'gone' },
    { failureClass: 'catalog_absent', reason: 'Not in the catalog.' },
    providerDown,
  ])(
    'keeps the $failureClass failure history when the catalog refuses a re-admit',
    async failure => {
      await failedRun('run-1', failure, T0);
      if ((await requeue(T0 + HOUR)) === 1) await failedRun('run-2', failure, T0 + 2 * HOUR);
      const before = stored();
      const [listedBefore] = await listCurrentFailedProfiles(db, current);
      expect(await refresh({ data: [] }, T0 + 5 * HOUR)).toEqual({
        refreshed: [],
        unavailable: [pair],
        skipped: [],
      });
      expect(stored()).toEqual(before);
      expect(before.first_failed_at).toBe(iso(T0));
      expect((await listCurrentFailedProfiles(db, current))[0]).toEqual(listedBefore);
    }
  );

  it('fails a never-failed pair permanently when the catalog refuses a re-admit', async () => {
    expect(await refresh({ data: [] }, T0 + HOUR)).toEqual({
      refreshed: [],
      unavailable: [pair],
      skipped: [],
    });
    expect(stored()).toMatchObject({
      status: 'unavailable',
      failure_class: 'catalog_absent',
      failure_attempts: 1,
      first_failed_at: iso(T0 + HOUR),
    });
  });

  it('lists only failed rows a queue still wants, with their queues', async () => {
    await failedRun('run-1', providerDown, T0);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, failure_reason, failure_class, failure_attempts, requested_at, updated_at,
          platform_requested, user_requested)
         VALUES ('efficient', 'vendor/orphan', 'high', ?, 1, 'unavailable', 'gone',
          'catalog_absent', 1, ?, ?, 0, 0),
          ('efficient', 'vendor/both', 'high', ?, 1, 'unavailable', 'gone',
          'catalog_absent', 1, ?, ?, 1, 1)`
      )
      .run(current.engineIdentity, iso(T0), iso(T0), current.engineIdentity, iso(T0), iso(T0));
    expect(
      (await listCurrentFailedProfiles(db, current)).map(entry => ({
        model: entry.model,
        variant: entry.variant,
        queues: entry.queues,
        kind: entry.failure.kind,
      }))
    ).toEqual([
      { model: 'vendor/both', variant: 'high', queues: ['platform', 'user'], kind: 'permanent' },
      { model: 'vendor/model', variant: null, queues: ['platform'], kind: 'retryable' },
    ]);
  });
});

describe('profile failure migration backfill', () => {
  it('marks catalog, context and model-not-found failures permanent and keeps the rest retryable', () => {
    const sqlite = new DatabaseSync(':memory:');
    const directory = new URL('../migrations/', import.meta.url);
    const migrations = readdirSync(directory)
      .filter(name => name.endsWith('.sql'))
      .sort();
    const backfill = migrations.findIndex(name => name.startsWith('0032_'));
    for (const name of migrations.slice(0, backfill)) {
      sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
    }
    const insert = sqlite.prepare(
      `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
        status, failure_reason, requested_at, updated_at, completed_at, platform_requested,
        user_requested)
       VALUES ('efficient', ?, '', 'engine', 1, ?, ?, '2026-11-19T22:00:00.000Z',
        '2026-11-19T22:59:00.000Z', ?, 1, 0)`
    );
    insert.run(
      'm/catalog',
      'failed',
      'Model or variant is unavailable in the executable benchmark catalog.',
      null
    );
    insert.run(
      'm/context',
      'failed',
      'Model context window leaves fewer than 20000 input tokens after the CLI completion reservation.',
      '2026-11-19T22:30:00.000Z'
    );
    insert.run(
      'm/not-found',
      'failed',
      'Exact benchmark model or variant is unavailable to the benchmark CLI; retry after availability is restored.',
      '2026-11-19T22:30:00.000Z'
    );
    insert.run(
      'm/lane',
      'failed',
      'Benchmark lane did not finish (queue retries exhausted or run timed out); retry to re-measure.',
      '2026-11-19T22:30:00.000Z'
    );
    insert.run('m/ready', 'ready', null, '2026-11-19T22:30:00.000Z');
    insert.run('m/pending', 'pending', null, null);

    sqlite.exec(readFileSync(new URL(migrations[backfill] ?? '', directory), 'utf8'));

    expect(
      sqlite
        .prepare(
          `SELECT model, status, failure_class, failure_attempts, first_failed_at, retry_after
           FROM benchmark_profiles ORDER BY model`
        )
        .all()
    ).toEqual([
      {
        model: 'm/catalog',
        status: 'unavailable',
        failure_class: 'catalog_absent',
        failure_attempts: 1,
        first_failed_at: '2026-11-19T22:59:00.000Z',
        retry_after: null,
      },
      {
        model: 'm/context',
        status: 'unavailable',
        failure_class: 'context_too_small',
        failure_attempts: 1,
        first_failed_at: '2026-11-19T22:30:00.000Z',
        retry_after: null,
      },
      {
        model: 'm/lane',
        status: 'failed',
        failure_class: 'unknown',
        failure_attempts: 1,
        first_failed_at: '2026-11-19T22:30:00.000Z',
        retry_after: '2026-11-19T22:30:00.000Z',
      },
      {
        model: 'm/not-found',
        status: 'unavailable',
        failure_class: 'model_not_found',
        failure_attempts: 1,
        first_failed_at: '2026-11-19T22:30:00.000Z',
        retry_after: null,
      },
      {
        model: 'm/pending',
        status: 'pending',
        failure_class: null,
        failure_attempts: 0,
        first_failed_at: null,
        retry_after: null,
      },
      {
        model: 'm/ready',
        status: 'ready',
        failure_class: null,
        failure_attempts: 0,
        first_failed_at: null,
        retry_after: null,
      },
    ]);
    sqlite.close();
  });
});

describe('unsupported provider rejection', () => {
  const rows = (count: number, error: string | null, timedOut = 0) =>
    Array.from({ length: count }, () => ({ error, timed_out: timedOut }));
  const toolUse =
    "\u001b[91m\u001b[1mError: \u001b[0mThis model doesn't support tool use in streaming mode.\n";

  it('fails an entry whose cases nearly all hit one rejection', () => {
    expect(unsupportedRejection([...rows(96, toolUse), ...rows(4, null)])).toEqual({
      failureClass: 'unsupported',
      reason:
        "96 of 100 measured cases failed with the same provider rejection: This model doesn't support tool use in streaming mode.",
    });
  });

  it('groups rejections that differ only in numbers', () => {
    const contextErrors = Array.from({ length: 20 }, (_, index) => ({
      error: `Error: This endpoint's maximum context length is 128000 tokens. However, you requested about ${183_000 + index} tokens`,
      timed_out: 0,
    }));
    expect(unsupportedRejection(contextErrors)?.failureClass).toBe('unsupported');
  });

  it.each([
    { name: 'below the share', input: [...rows(94, toolUse), ...rows(6, null)] },
    { name: 'timeouts', input: rows(100, 'Error: Upstream idle timeout exceeded') },
    { name: 'timed-out cases', input: rows(100, toolUse, 1) },
    {
      name: 'content filters',
      input: rows(100, "Error: The response was blocked by the provider's content filter"),
    },
    {
      name: 'throttles',
      input: rows(100, 'Error: Too Many Requests: Too many requests. Please try again later.'),
    },
    {
      name: 'empty output',
      input: rows(
        100,
        'Error: run ended without an assistant message; the model returned no output'
      ),
    },
    { name: 'wrong answers', input: rows(100, null) },
    { name: 'no cases', input: [] },
  ])('keeps $name as a measurement', ({ input }) => {
    expect(unsupportedRejection(input)).toBeNull();
  });
});

describe('settled run classification (production migrations and real SQLite)', () => {
  const RUN_ID = 'decider-settle';
  let sqlite: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: { send: async () => {} },
      BENCHMARK_SCHEDULER_CONFIG: '{}',
      AUTO_ROUTING_CONFIG: { put: async () => {}, delete: async () => {} },
    } as unknown as Env;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('fails dead lanes with their most severe recorded cause and all-rejected entries as unsupported', async () => {
    const engineIdentity = computeEngineIdentity('decider', 'efficient');
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity, benchmark_user_id,
          benchmark_org_id)
         VALUES (?, 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 0, 1, ?,
          'bot-internal-benchmark', 'benchmark-org')`
      )
      .run(RUN_ID, now, engineIdentity);
    sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(RUN_ID);
    for (const model of ['lane/dead', 'lane/rejected', 'lane/healthy']) {
      sqlite
        .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
        .run(RUN_ID, model);
      sqlite
        .prepare(
          `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
            status, run_id, requested_at, updated_at, platform_requested, user_requested)
           VALUES ('efficient', ?, '', ?, 1, 'running', ?, ?, ?, 1, 0)`
        )
        .run(model, engineIdentity, RUN_ID, now, now);
    }
    const insertCase = sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, error, rep)
       VALUES (?, ?, '', ?, ?, 10, ?, 0)`
    );
    for (const [index, benchCase] of DECIDER_CASES.entries()) {
      insertCase.run(
        RUN_ID,
        'lane/rejected',
        benchCase.id,
        0,
        "Error: This model doesn't support tool use in streaming mode."
      );
      insertCase.run(
        RUN_ID,
        'lane/healthy',
        benchCase.id,
        index % 2,
        index % 2 === 0 ? 'Error: Upstream idle timeout exceeded' : null
      );
    }
    for (const [chunk, failureClass] of [
      [0, 'ambiguous_execution'],
      [1, 'provider_unavailable'],
    ] as const) {
      await recordLaneFailure(env.BENCH_DB, {
        runId: RUN_ID,
        model: 'lane/dead',
        variant: '',
        rep: 0,
        chunk,
        shard: 0,
        failureClass,
      });
    }

    await dispatchScheduler(env);

    expect(
      sqlite
        .prepare(
          `SELECT model, status, failure_class, failure_attempts, model_failure_attempts
           FROM benchmark_profiles ORDER BY model`
        )
        .all()
    ).toEqual([
      {
        model: 'lane/dead',
        status: 'failed',
        failure_class: 'provider_unavailable',
        failure_attempts: 1,
        model_failure_attempts: 1,
      },
      {
        model: 'lane/healthy',
        status: 'ready',
        failure_class: null,
        failure_attempts: 0,
        model_failure_attempts: 0,
      },
      {
        model: 'lane/rejected',
        status: 'unavailable',
        failure_class: 'unsupported',
        failure_attempts: 1,
        model_failure_attempts: 0,
      },
    ]);
    expect(sqlite.prepare('SELECT status FROM benchmark_runs WHERE id = ?').get(RUN_ID)).toEqual({
      status: 'completed',
    });
  });
});

describe('catalog load deferrals (production migrations and real SQLite)', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z');

  it('refunds the attempt, counts the deferral and holds every dispatch until the cooldown ends', async () => {
    const sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    const db = sqliteD1(sqlite);
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity)
         VALUES ('run', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 4, 1, 'engine')`
      )
      .run(iso(NOW));
    await scheduleRunChunks(db, {
      runId: 'run',
      entries: [
        { model: 'a/model', variant: null, providers: ['deepinfra'] },
        { model: 'b/model', variant: null, providers: ['together'] },
      ],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimScheduledChunks(db, config, NOW, 'first');
    if (!claim) throw new Error('Expected a claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);

    await deferCatalogChunk(db, claim.id, claim.token, NOW + 15_000);
    await cooldownCatalog(db, NOW + 15_000);

    expect(
      sqlite
        .prepare(
          'SELECT status, attempts, catalog_deferrals, available_at FROM scheduler_chunks WHERE id = ?'
        )
        .get(claim.id)
    ).toEqual({ status: 'pending', attempts: 0, catalog_deferrals: 1, available_at: NOW + 15_000 });
    expect(await claimScheduledChunks(db, config, NOW + 1_000, 'cooling')).toEqual([]);
    expect(await claimScheduledChunks(db, config, NOW + 15_000, 'after')).toHaveLength(1);
    sqlite.close();
  });
});
