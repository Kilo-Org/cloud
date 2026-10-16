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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [] }));
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
        min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity
      ) VALUES (?, 'efficient', 'decider', ?, 'running', ?, 0.7, 3, 0, ?, 'scheduler-init-test')
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
