import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { DECIDER_CASES } from './datasets/decider-cases';
import { dispatchScheduler, type BenchmarkJobMessage } from './run';
import {
  acquireInitializationLease,
  finishChunk,
  scheduleRunChunks,
  startChunk,
  SCHEDULER_INIT_LEASE_MS,
} from './scheduler';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const CRON_PERIOD_MS = 60_000;
const WORKER_WALL_MS = 15 * 60_000;
// Each D1 call advances the simulated clock, so one 50-chunk batch (a status read and
// a write) costs half a second and a 100k-chunk run cannot initialize in one Worker
// invocation.
const D1_CALL_MS = 250;

class WallTimeExceeded extends Error {}

describe('scheduler initialization across dispatch ticks (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let setupDb: D1Database;
  let env: Env;
  let sent: BenchmarkJobMessage[];
  let tickStartedAt: number | null;
  let onD1Call: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url.href === 'https://app.test/api/internal/auto-routing-benchmark/token') {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON token request.');
        expect(init?.method).toBe('POST');
        expect(headers.get('authorization')).toBe(`Bearer ${'internal-test-secret'}`);
        expect(JSON.parse(init.body)).toEqual({
          userId: 'scheduler-user',
          organizationId: 'scheduler-org',
        });
        return Response.json({
          token: 'scheduler-test-token',
          expiresAt: new Date(NOW + 60 * 60_000).toISOString(),
        });
      }
      if (url.href === 'https://api.test/api/organizations/scheduler-org/models') {
        expect(headers.get('authorization')).toBe(`Bearer ${'scheduler-test-token'}`);
        expect(headers.get('X-KiloCode-OrganizationId')).toBe('scheduler-org');
        return Response.json({
          data: sqlite
            .prepare('SELECT DISTINCT model FROM run_models')
            .all()
            .map(row => ({
              id: row.model,
              supported_parameters: ['tools'],
            })),
        });
      }
      throw new Error(`Unexpected fixture request: ${url.href}`);
    });
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    setupDb = sqliteD1(sqlite);
    sent = [];
    tickStartedAt = null;
    onD1Call = () => {};
    env = {
      BENCH_DB: sqliteD1(sqlite, () => {
        if (tickStartedAt === null) return;
        vi.setSystemTime(Date.now() + D1_CALL_MS);
        if (Date.now() - tickStartedAt > WORKER_WALL_MS) throw new WallTimeExceeded();
        onD1Call();
      }),
      BENCH_QUEUE: {
        send: async (message: BenchmarkJobMessage) => {
          sent.push(message);
        },
      },
      BENCHMARK_SCHEDULER_CONFIG: '{}',
      KILO_WEB_API_BASE_URL: 'https://app.test',
      KILO_CLI_API_URL: 'https://api.test',
      INTERNAL_API_SECRET_PROD: { get: async () => 'internal-test-secret' },
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
    models: number,
    repetitions: number
  ) {
    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at,
        min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity,
        benchmark_user_id, benchmark_org_id
      ) VALUES (?, 'efficient', 'decider', ?, 'running', ?, 0.7, 3, 0, ?, 'scheduler-init-test',
        'scheduler-user', 'scheduler-org')
    `)
      .run(id, purpose, new Date(NOW).toISOString(), repetitions);
    const model = sqlite.prepare(
      "INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)"
    );
    for (let index = 0; index < models; index++) model.run(id, `${id}/model-${index}`);
  }

  function chunkCount(runId: string): number {
    const row = sqlite
      .prepare('SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id = ?')
      .get(runId);
    return Number(row?.n);
  }

  function initialized(runId: string): boolean {
    return sqlite.prepare('SELECT 1 FROM scheduler_runs WHERE run_id = ?').get(runId) !== undefined;
  }

  async function insertInitializedRun(id: string) {
    insertRun(id, 'platform', 1, 3);
    await scheduleRunChunks(setupDb, {
      runId: id,
      entries: [{ model: `${id}/model-0`, variant: null, providers: ['deepinfra'] }],
      repetitions: 3,
      caseIds: DECIDER_CASES.map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    expect(initialized(id)).toBe(true);
  }

  /**
   * One per-minute dispatch. Chunks claimed by the previous tick finish first so
   * initialized runs always have free capacity, and a tick past the Worker wall limit
   * is killed mid-flight like the platform would.
   */
  async function tick(): Promise<{ claims: BenchmarkJobMessage[]; killed: boolean; ms: number }> {
    for (const message of sent) {
      if (!message.claimId || !message.claimToken) continue;
      await startChunk(setupDb, message.claimId, message.claimToken, Date.now());
      await finishChunk(setupDb, message.claimId, message.claimToken);
    }
    sent = [];
    const startedAt = Date.now();
    tickStartedAt = startedAt;
    let killed = false;
    try {
      await dispatchScheduler(env);
    } catch (error) {
      if (!(error instanceof WallTimeExceeded)) throw error;
      killed = true;
    }
    tickStartedAt = null;
    const ms = Date.now() - startedAt;
    vi.setSystemTime(Math.max(Date.now(), startedAt + CRON_PERIOD_MS));
    return { claims: sent, killed, ms };
  }

  it('settles failed-lane tails without completing a run that still has runnable work', async () => {
    insertRun('settled', 'user', 2, 1);
    insertRun('busy', 'platform', 1, 1);
    for (const id of ['settled', 'busy']) {
      await scheduleRunChunks(setupDb, {
        runId: id,
        entries: [{ model: `${id}/model-0`, variant: null, providers: ['deepinfra'] }],
        repetitions: 1,
        caseIds: DECIDER_CASES.map(benchCase => benchCase.id),
        chunkSize: 1,
      });
      sqlite
        .prepare(`INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at
        ) VALUES ('efficient', ?, '', 'scheduler-init-test', 1, 'running', ?, ?, ?)`)
        .run(`${id}/model-0`, id, new Date(NOW).toISOString(), new Date(NOW).toISOString());
    }
    sqlite
      .prepare(`INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at)
        VALUES ('settled', 'settled/model-0', '', 0, 0, 0, ?)`)
      .run(new Date(NOW).toISOString());
    sqlite
      .prepare(`INSERT INTO benchmark_profiles (
        router, model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at
      ) VALUES ('efficient', 'settled/model-1', '', 'scheduler-init-test', 1, 'running', 'settled', ?, ?)`)
      .run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
    const result = sqlite.prepare(`INSERT INTO case_results (
      run_id, model, variant, case_id, route_key, score, latency_ms, cost_usd, rep, exit_code
    ) VALUES ('settled', 'settled/model-1', '', ?, ?, 1, 100, 0, 0, 0)`);
    for (const benchCase of DECIDER_CASES) {
      result.run(benchCase.id, `${benchCase.taskType}/${benchCase.subtaskType}`);
    }
    sqlite
      .prepare(`UPDATE scheduler_chunks SET status = 'active', slot = 0, lease_until = ?
        WHERE run_id = 'settled' AND chunk = 0`)
      .run(NOW + 60_000);
    await dispatchScheduler(env);
    expect(sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'settled'").get()).toEqual({
      status: 'running',
    });
    sqlite
      .prepare(`UPDATE scheduler_chunks SET status = 'failed', slot = NULL, lease_until = 0
        WHERE run_id = 'settled' AND chunk = 0`)
      .run();

    await dispatchScheduler(env);

    expect(sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'settled'").get()).toEqual({
      status: 'completed',
    });
    expect(
      sqlite
        .prepare(
          "SELECT model, status FROM benchmark_profiles WHERE run_id = 'settled' ORDER BY model"
        )
        .all()
    ).toEqual([
      { model: 'settled/model-0', status: 'failed' },
      { model: 'settled/model-1', status: 'ready' },
    ]);
    expect(sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'busy'").get()).toEqual({
      status: 'running',
    });
    expect(sent.some(message => message.runId === 'busy')).toBe(true);
    expect(sent.some(message => message.runId === 'settled')).toBe(false);
  });

  it('fails an identity-less run and releases its profiles without blocking a sibling', async () => {
    insertRun('invalid', 'platform', 1, 1);
    insertRun('healthy', 'user', 1, 1);
    sqlite.prepare("UPDATE benchmark_runs SET benchmark_user_id = NULL WHERE id = 'invalid'").run();
    sqlite
      .prepare(`INSERT INTO benchmark_profiles (
      router, model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at
    ) VALUES ('efficient', 'invalid/model-0', '', 'scheduler-init-test', 1, 'running', 'invalid', ?, ?)`)
      .run(new Date(NOW).toISOString(), new Date(NOW).toISOString());

    const result = await tick();

    expect(sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'invalid'").get()).toEqual({
      status: 'failed',
    });
    expect(
      sqlite.prepare("SELECT status FROM benchmark_profiles WHERE run_id = 'invalid'").get()
    ).toEqual({ status: 'failed' });
    expect(chunkCount('invalid')).toBe(0);
    expect(initialized('healthy')).toBe(true);
    expect(result.claims.some(claim => claim.runId === 'healthy')).toBe(true);
  });

  it('contains a temporary catalog failure while initializing and dispatching a sibling', async () => {
    insertRun('retryable', 'platform', 1, 1);
    insertRun('healthy', 'user', 1, 1);
    sqlite
      .prepare("UPDATE benchmark_runs SET benchmark_user_id = 'retry-user' WHERE id = 'retryable'")
      .run();
    const fetcher = vi.mocked(globalThis.fetch);
    const base = fetcher.getMockImplementation();
    if (!base) throw new Error('Catalog fixture was not installed.');
    fetcher.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        url.pathname === '/api/internal/auto-routing-benchmark/token' &&
        typeof init?.body === 'string'
      ) {
        const body: unknown = JSON.parse(init.body);
        if (
          typeof body === 'object' &&
          body !== null &&
          'userId' in body &&
          body.userId === 'retry-user'
        ) {
          return new Response(null, { status: 503 });
        }
      }
      return base(input, init);
    });

    const result = await tick();

    expect(
      sqlite.prepare("SELECT status FROM benchmark_runs WHERE id = 'retryable'").get()
    ).toEqual({ status: 'running' });
    expect(initialized('retryable')).toBe(false);
    expect(initialized('healthy')).toBe(true);
    expect(result.claims.some(claim => claim.runId === 'healthy')).toBe(true);
  });

  it('initializes a 100k-chunk run over bounded ticks while another run is claimed every tick', async () => {
    const entries = 58;
    const repetitions = 3;
    const total = entries * repetitions * DECIDER_CASES.length;
    // A 20s budget at half a second per batch writes about 2,000 new chunks a tick,
    // so ~50 ticks suffice; re-walking materialized lanes would shrink that every tick.
    const maxTicks = 60;
    const minNewChunksPerTick = 1_500;
    await insertInitializedRun('steady');
    insertRun('large', 'user', entries, repetitions);

    let previous = 0;
    let ticks = 0;
    let finalClaims: BenchmarkJobMessage[] = [];
    while (!initialized('large')) {
      ticks++;
      expect(ticks, 'ticks to initialize the large run').toBeLessThanOrEqual(maxTicks);
      const { claims, killed, ms } = await tick();
      const materialized = chunkCount('large');
      expect(
        claims.filter(claim => claim.runId === 'steady').length,
        `steady claims on tick ${ticks}`
      ).toBeGreaterThan(0);
      expect(killed, `tick ${ticks} hit the Worker wall limit`).toBe(false);
      expect(ms, `tick ${ticks} simulated duration`).toBeLessThan(CRON_PERIOD_MS);
      expect(materialized, `chunks after tick ${ticks}`).toBeGreaterThan(previous);
      if (!initialized('large')) {
        expect(materialized - previous, `new chunks on tick ${ticks}`).toBeGreaterThanOrEqual(
          minNewChunksPerTick
        );
      }
      previous = materialized;
      finalClaims = claims;
    }

    expect(chunkCount('large')).toBe(total);
    expect(
      sqlite
        .prepare(`
        SELECT COUNT(*) AS lanes, MIN(written) AS fewest, MAX(written) AS most,
          MIN(last) AS lowest_last, MAX(last) AS highest_last
        FROM (
          SELECT COUNT(*) AS written, MAX(chunk) AS last FROM scheduler_chunks
          WHERE run_id = 'large' GROUP BY model, variant, rep
        )
      `)
        .get()
    ).toEqual({
      lanes: entries * repetitions,
      fewest: DECIDER_CASES.length,
      most: DECIDER_CASES.length,
      lowest_last: DECIDER_CASES.length - 1,
      highest_last: DECIDER_CASES.length - 1,
    });
    expect(finalClaims.some(claim => claim.runId === 'large')).toBe(true);
  }, 120_000);

  it('claims while another pass holds the initialization lease and initializes after it expires', async () => {
    await insertInitializedRun('steady');
    insertRun('waiting', 'user', 1, 1);
    expect(await acquireInitializationLease(setupDb, 'other-pass', Date.now())).toBe(true);

    const held = await tick();
    expect(held.claims.filter(claim => claim.runId === 'steady').length).toBeGreaterThan(0);
    expect(chunkCount('waiting')).toBe(0);

    vi.setSystemTime(NOW + SCHEDULER_INIT_LEASE_MS);
    const released = await tick();
    expect(initialized('waiting')).toBe(true);
    expect(chunkCount('waiting')).toBe(DECIDER_CASES.length);
    expect(released.claims.some(claim => claim.runId === 'waiting')).toBe(true);
  });

  it('stops materializing a run that stops running mid-pass and in later ticks', async () => {
    insertRun('abandoned', 'user', 8, 1);
    const stopAfter = 500;
    onD1Call = () => {
      if (chunkCount('abandoned') >= stopAfter) {
        sqlite.prepare("UPDATE benchmark_runs SET status = 'failed' WHERE id = 'abandoned'").run();
      }
    };
    await tick();
    const materialized = chunkCount('abandoned');
    expect(materialized).toBeGreaterThanOrEqual(stopAfter);
    expect(materialized).toBeLessThan(stopAfter + 100);

    await tick();
    expect(chunkCount('abandoned')).toBe(materialized);
    expect(initialized('abandoned')).toBe(false);
  });
});
