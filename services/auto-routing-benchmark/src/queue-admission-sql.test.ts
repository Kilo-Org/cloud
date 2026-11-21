import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveEffectivePolicy, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { saveBenchmarkConfig } from './config';
import { DECIDER_CASES } from './datasets/decider-cases';
import { insertRun as insertRunRow, MAX_RUNNING_RUNS_PER_QUEUE } from './db';
import { ACTIVE_MEASUREMENT_REVISION, MEASUREMENT_REVISION } from './measurement-revision';
import {
  computeEngineIdentity,
  dispatchScheduler,
  drainQueue,
  type BenchmarkJobMessage,
} from './run';
import {
  claimScheduledChunks,
  finishChunk,
  scheduleRunChunks,
  schedulerConfig,
  startChunk,
} from './scheduler';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const BENCHMARK_USER = 'bot-internal-queue-admission';
const BENCHMARK_ORG = 'queue-admission-org';
const NEW_MODEL = 'vendor/new-model';

/** Holds a drain's run-insert batch, before or after it commits, until `hold` settles. */
function holdingRunInsert(
  db: D1Database,
  hold: (phase: 'before' | 'after') => Promise<void>
): D1Database {
  let insertingRun = false;
  return {
    prepare(query: string) {
      if (query.includes('INSERT INTO benchmark_runs')) insertingRun = true;
      return db.prepare(query);
    },
    async batch(statements: D1PreparedStatement[]) {
      if (!insertingRun) return db.batch(statements);
      insertingRun = false;
      await hold('before');
      const results = await db.batch(statements);
      await hold('after');
      return results;
    },
    exec: (query: string) => db.exec(query),
  } as D1Database;
}

describe('decider queue admission (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let sent: BenchmarkJobMessage[];
  const repetitionsByRouter = new Map<AutoRouter, number>();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.href === 'https://app.test/api/internal/bot-token') {
        return Response.json({
          token: 'queue-admission-token',
          expiresAt: new Date(NOW + 3600_000).toISOString(),
        });
      }
      if (url.href === `https://api.test/api/organizations/${BENCHMARK_ORG}/models`) {
        const models = sqlite
          .prepare('SELECT model FROM run_models UNION SELECT model FROM benchmark_profiles')
          .all()
          .map(row => String(row.model));
        return Response.json({
          data: models.map(id => ({ id, supported_parameters: ['tools'] })),
        });
      }
      throw new Error(`Unexpected fixture request: ${url.href}`);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sent = [];
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: {
        send: async (message: BenchmarkJobMessage) => {
          sent.push(message);
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: '{}',
      KILO_WEB_API_BASE_URL: 'https://app.test',
      KILO_CLI_API_URL: 'https://api.test',
      BOT_TOKEN_MINT_SECRET: { get: async () => 'mint-test-secret' },
    } as unknown as Env;
    for (const router of ['efficient', 'frontier'] as const) {
      const saved = await saveBenchmarkConfig(
        env.BENCH_DB,
        {
          router,
          accuracyNoiseBand: 0.05,
          classifierModels: ['classifier/model'],
          deciderModels: [{ id: 'platform/model' }],
          minAccuracy: 0.7,
          productionTokenProfile: null,
          switchHorizonTurns: null,
          benchmarkUserId: BENCHMARK_USER,
          benchmarkOrgId: BENCHMARK_ORG,
          updatedAt: null,
          updatedBy: null,
        },
        'test'
      );
      repetitionsByRouter.set(router, resolveEffectivePolicy(saved).deciderRepetitions);
    }
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function repetitionsOf(router: AutoRouter): number {
    const repetitions = repetitionsByRouter.get(router);
    if (repetitions === undefined) throw new Error(`Missing repetitions for ${router}`);
    return repetitions;
  }

  function insertRun(
    id: string,
    models: readonly string[],
    router: AutoRouter = 'efficient',
    purpose: 'platform' | 'user' = 'user'
  ) {
    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
        max_concurrency, repetitions, engine_identity, benchmark_user_id, benchmark_org_id
      ) VALUES (?, ?, 'decider', ?, 'running', ?, 0.7, 3, 0, ?, ?, ?, ?)
    `)
      .run(
        id,
        router,
        purpose,
        new Date(Date.now()).toISOString(),
        repetitionsOf(router),
        computeEngineIdentity('decider', router),
        BENCHMARK_USER,
        BENCHMARK_ORG
      );
    for (const model of models) {
      sqlite
        .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
        .run(id, model);
      insertProfile(model, 'running', id, router);
    }
  }

  function insertProfile(
    model: string,
    status: 'pending' | 'running',
    runId: string | null,
    router: AutoRouter = 'efficient'
  ) {
    sqlite
      .prepare(`
      INSERT INTO benchmark_profiles (
        router, model, variant, engine_identity, repetitions, status, run_id,
        requested_at, updated_at, platform_requested, user_requested
      ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 0, 1)
    `)
      .run(
        router,
        model,
        computeEngineIdentity('decider', router),
        repetitionsOf(router),
        status,
        runId,
        new Date(Date.now()).toISOString(),
        new Date(Date.now()).toISOString()
      );
  }

  async function initialize(runId: string, models: readonly string[]) {
    const run = sqlite.prepare('SELECT repetitions FROM benchmark_runs WHERE id = ?').get(runId) as
      | { repetitions: number }
      | undefined;
    if (!run) throw new Error(`Missing seeded run ${runId}`);
    expect(
      await scheduleRunChunks(env.BENCH_DB, {
        runId,
        entries: models.map(model => ({ model, variant: null })),
        repetitions: run.repetitions,
        caseIds: DECIDER_CASES.slice(0, 3).map(benchCase => benchCase.id),
        chunkSize: 1,
      })
    ).toBe(true);
  }

  function runningUserRuns(): string[] {
    return sqlite
      .prepare(
        "SELECT id FROM benchmark_runs WHERE purpose = 'user' AND status = 'running' ORDER BY started_at, id"
      )
      .all()
      .map(row => String(row.id));
  }

  function profile(model: string) {
    return sqlite
      .prepare('SELECT status, run_id FROM benchmark_profiles WHERE model = ?')
      .get(model);
  }

  function initialized(runId: string): boolean {
    return sqlite.prepare('SELECT 1 FROM scheduler_runs WHERE run_id = ?').get(runId) !== undefined;
  }

  it('starts a second run for a new entry beside an active 100-entry run whose dispatcher claims its first chunk', async () => {
    const large = Array.from({ length: 100 }, (_, index) => `vendor/large-${index}`);
    insertRun('user-large', large);
    await initialize('user-large', large);
    const held = await claimScheduledChunks(
      env.BENCH_DB,
      schedulerConfig('{"slots":100,"modelConcurrency":1}'),
      Date.now(),
      'large-held'
    );
    expect(held).toHaveLength(100);
    vi.setSystemTime(NOW + 60_000);
    insertProfile(NEW_MODEL, 'pending', null);

    const started = await drainQueue(env, 'user');

    if (!started) throw new Error('Expected the drain to start a run');
    const { runId } = started;
    expect(started.entryCount).toBe(1);
    expect(runningUserRuns()).toEqual(['user-large', runId]);
    expect(profile(NEW_MODEL)).toEqual({ status: 'running', run_id: runId });
    expect(
      sqlite.prepare('SELECT measurement_revision FROM benchmark_runs WHERE id = ?').get(runId)
    ).toEqual({ measurement_revision: ACTIVE_MEASUREMENT_REVISION });
    // The drain writes the run row and wakes the dispatcher, which materializes
    // the run and claims its first chunk on the same wake.
    expect(sent).toContainEqual(
      expect.objectContaining({ runId, kind: 'decider', schedulerWake: true })
    );
    expect(sent.some(message => message.claimId)).toBe(false);
    await dispatchScheduler(env);

    expect(initialized(runId)).toBe(true);

    // Every slot is held, so the next freed one must go to the new run's model,
    // which holds fewer live chunks than any model of the large run.
    const released = held[0];
    if (!released) throw new Error('Expected a held claim');
    await startChunk(env.BENCH_DB, released.id, released.token, Date.now());
    await finishChunk(env.BENCH_DB, released.id, released.token);
    await dispatchScheduler(env);

    const claim = sent.find(
      message => message.runId === runId && message.model === NEW_MODEL && message.claimId
    );
    if (!claim?.claimId) throw new Error('Expected a claim for the new entry');
    expect(
      sqlite
        .prepare('SELECT model, rep, chunk, status, slot FROM scheduler_chunks WHERE id = ?')
        .get(claim.claimId)
    ).toEqual({ model: NEW_MODEL, rep: 0, chunk: 0, status: 'queued', slot: released.slot });
  }, 30_000);

  it('waits while a run of the queue is still starting, then starts once it is initialized', async () => {
    insertRun('user-starting', ['vendor/starting']);
    vi.setSystemTime(NOW + 60_000);
    insertProfile(NEW_MODEL, 'pending', null);

    expect(await drainQueue(env, 'user')).toBeNull();
    expect(profile(NEW_MODEL)).toEqual({ status: 'pending', run_id: null });
    expect(runningUserRuns()).toEqual(['user-starting']);

    await dispatchScheduler(env);
    expect(initialized('user-starting')).toBe(true);

    const started = await drainQueue(env, 'user');
    expect(profile(NEW_MODEL)).toEqual({ status: 'running', run_id: started?.runId });
  });

  it('does not let a starting run of another queue or router hold this queue back', async () => {
    insertRun('platform-starting', ['vendor/platform-starting'], 'efficient', 'platform');
    insertRun('frontier-user-starting', ['vendor/frontier-starting'], 'frontier');
    insertProfile(NEW_MODEL, 'pending', null);

    const started = await drainQueue(env, 'user');

    expect(profile(NEW_MODEL)).toEqual({ status: 'running', run_id: started?.runId });
  });

  it('holds new entries while the queue has its maximum of active runs', async () => {
    const active = Array.from({ length: MAX_RUNNING_RUNS_PER_QUEUE }, (_, index) => ({
      id: `user-active-${index}`,
      model: `vendor/active-${index}`,
    }));
    for (const run of active) {
      insertRun(run.id, [run.model]);
      await initialize(run.id, [run.model]);
    }
    insertProfile(NEW_MODEL, 'pending', null);

    expect(await drainQueue(env, 'user')).toBeNull();
    expect(profile(NEW_MODEL)).toEqual({ status: 'pending', run_id: null });

    sqlite
      .prepare("UPDATE benchmark_runs SET status = 'completed' WHERE id = 'user-active-0'")
      .run();
    const started = await drainQueue(env, 'user');
    expect(profile(NEW_MODEL)).toEqual({ status: 'running', run_id: started?.runId });
  });

  it('initializes a starting run of every router and queue in one dispatch pass', async () => {
    const starting = [
      { id: 'efficient-platform-starting', router: 'efficient', purpose: 'platform' },
      { id: 'efficient-user-starting', router: 'efficient', purpose: 'user' },
      { id: 'frontier-platform-starting', router: 'frontier', purpose: 'platform' },
      { id: 'frontier-user-starting', router: 'frontier', purpose: 'user' },
    ] as const;
    for (const [index, run] of starting.entries()) {
      vi.setSystemTime(NOW + index * 1000);
      insertRun(run.id, [`vendor/${run.id}`], run.router, run.purpose);
    }

    await dispatchScheduler(env);

    expect(starting.filter(run => !initialized(run.id))).toEqual([]);
  });

  it('stores the measurement revision the admitted decider run was started under', async () => {
    const run = {
      id: 'revision-3-run',
      router: 'efficient' as const,
      kind: 'decider' as const,
      startedAt: new Date(Date.now()).toISOString(),
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05,
      max_concurrency: 0,
      benchmark_user_id: BENCHMARK_USER,
      benchmark_org_id: BENCHMARK_ORG,
      repetitions: repetitionsOf('efficient'),
      classifier_max_p95_latency_ms: null,
      engine_identity: computeEngineIdentity('decider', 'efficient'),
      measurement_revision: MEASUREMENT_REVISION,
      purpose: 'user' as const,
    };

    expect(await insertRunRow(env.BENCH_DB, run, [], [])).toEqual({ admitted: true });

    expect(
      sqlite.prepare('SELECT measurement_revision FROM benchmark_runs WHERE id = ?').get(run.id)
    ).toEqual({ measurement_revision: MEASUREMENT_REVISION });
  });

  it('lets exactly one of two overlapping drains start a run', async () => {
    insertProfile('vendor/first', 'pending', null);
    const firstAtInsert = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const secondInserted = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();

    const first = drainQueue(
      {
        ...env,
        BENCH_DB: holdingRunInsert(env.BENCH_DB, async phase => {
          if (phase !== 'before') return;
          firstAtInsert.resolve();
          await firstRelease.promise;
        }),
      },
      'user'
    );
    await firstAtInsert.promise;
    insertProfile('vendor/second', 'pending', null);
    const second = drainQueue(
      {
        ...env,
        BENCH_DB: holdingRunInsert(env.BENCH_DB, async phase => {
          if (phase !== 'after') return;
          secondInserted.resolve();
          await secondRelease.promise;
        }),
      },
      'user'
    );
    await secondInserted.promise;
    firstRelease.resolve();
    const firstResult = await first;
    secondRelease.resolve();
    const secondResult = await second;

    expect(firstResult).toBeNull();
    if (!secondResult) throw new Error('Expected the second drain to start a run');
    expect(runningUserRuns()).toEqual([secondResult.runId]);
    expect(profile('vendor/first')).toEqual({ status: 'pending', run_id: null });
    expect(profile('vendor/second')).toEqual({ status: 'running', run_id: secondResult.runId });
    expect(
      vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))
    ).toContainEqual(
      expect.objectContaining({
        event: 'benchmark_queue_drain_skipped_run_starting',
        startingRunId: secondResult.runId,
      })
    );
  });
});
