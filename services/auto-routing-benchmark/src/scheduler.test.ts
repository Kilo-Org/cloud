import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { markStaleRunsFailed, restartPaidCaseRunStatement } from './db';
import {
  acquireInitializationLease,
  beginPaidCase,
  claimScheduledChunks,
  clearUnbilledCase,
  cooldownModel,
  deferChunk,
  deferNoModelCallChunk,
  deferThrottledChunk,
  finishChunk,
  failScheduledEntry,
  getPaidCasePromptRevision,
  getPaidCaseStartedAt,
  hasUnsettledChunks,
  recoverChunks,
  restartPaidCase,
  scheduleRunChunks,
  schedulerConfig,
  startChunk,
  SCHEDULER_ACTIVE_LEASE_MS,
  SCHEDULER_DISPATCH_LEASE_MS,
  SCHEDULER_INSERT_CHUNK_SQL,
  SCHEDULER_LANE_HEADS_SQL,
  SCHEDULER_LIVE_SQL,
  SCHEDULER_MATERIALIZED_LANES_SQL,
  SCHEDULER_MAX_PLATFORM_ATTEMPTS,
  SCHEDULER_MAX_USER_ATTEMPTS,
  SCHEDULER_MATERIALIZED_PAGE_SIZE,
  consumeRetryAttemptStatement,
  refundUnspentRetryAttempt,
  restartPaidCaseStatement,
  SCHEDULER_MAX_NO_MODEL_REATTEMPTS,
  SCHEDULER_QUEUE_LEASE_MS,
  SCHEDULER_PRUNE_CHUNKS_SQL,
  SCHEDULER_PRUNE_EXECUTIONS_SQL,
  SCHEDULER_PRUNE_MARKERS_SQL,
  SCHEDULER_SETTLED_RUNS_SQL,
  SCHEDULER_UNRECORDED_FAILED_CHUNKS_SQL,
  SCHEDULER_UNSETTLED_SQL,
} from './scheduler';
import type { SchedulerClaim, SchedulerConfig } from './scheduler';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

type TestEntry = { model: string; variant: string | null };
type StoredChunk = Omit<SchedulerClaim, 'slot' | 'token'> & {
  status: 'pending' | 'queued' | 'active' | 'completed' | 'failed';
  token: string | null;
  slot: number | null;
  lease_until: number;
  available_at: number;
};
type RunOptions = {
  router?: 'efficient' | 'frontier';
  purpose?: 'platform' | 'user';
  kind?: 'classifier' | 'decider';
  startedAt?: string;
};

function insertRun(sqlite: DatabaseSync, id: string, options: RunOptions = {}) {
  sqlite
    .prepare(`
    INSERT INTO benchmark_runs (
      id, router, kind, purpose, status, started_at,
      min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity,
      admission_marker
    ) VALUES (?, ?, ?, ?, 'running', ?, 0.7, 3, 4, 1, 'scheduler-storage-test', ?)
  `)
    .run(
      id,
      options.router ?? 'efficient',
      options.kind ?? 'decider',
      options.purpose ?? 'platform',
      options.startedAt ?? new Date(NOW).toISOString(),
      // These fixtures are post-cutover work: a real admission marker is what makes a run
      // claimable at all.
      crypto.randomUUID()
    );
}

function storedChunks(sqlite: DatabaseSync): StoredChunk[] {
  return sqlite.prepare('SELECT * FROM scheduler_chunks ORDER BY id').all() as StoredChunk[];
}

function liveChunks(sqlite: DatabaseSync): StoredChunk[] {
  return sqlite
    .prepare(`
    SELECT * FROM scheduler_chunks WHERE status IN ('queued', 'active') ORDER BY slot
  `)
    .all() as StoredChunk[];
}

function storedChunk(sqlite: DatabaseSync, id: string): StoredChunk {
  const row = sqlite.prepare('SELECT * FROM scheduler_chunks WHERE id = ?').get(id);
  if (!row) throw new Error(`Missing persisted scheduler chunk ${id}`);
  return row as StoredChunk;
}

async function claimMany(
  db: D1Database,
  config: SchedulerConfig,
  count: number,
  prefix: string,
  now = NOW
) {
  const claims: SchedulerClaim[] = [];
  while (claims.length < count) {
    const claimed = await claimScheduledChunks(db, config, now, `${prefix}-${claims.length}`);
    if (claimed.length === 0) break;
    claims.push(...claimed);
  }
  return claims;
}

function recordingD1(target: D1Database, statements: string[]): D1Database {
  return {
    prepare(sql: string) {
      statements.push(sql);
      return target.prepare(sql);
    },
    batch(list: D1PreparedStatement[]) {
      return target.batch(list);
    },
    exec(sql: string) {
      return target.exec(sql);
    },
  } as D1Database;
}

function explainPlan(sqlite: DatabaseSync, sql: string): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
    .map(row => row.detail)
    .join('\n');
}

function paidCase(claim: SchedulerClaim, caseId: string) {
  return {
    runId: claim.run_id,
    model: claim.model,
    variant: claim.variant,
    rep: claim.rep,
    caseId,
    token: claim.token,
  };
}

const independentEntries = (count: number): TestEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    model: `model-${index.toString().padStart(3, '0')}`,
    variant: '',
  }));

describe('scheduler (production migrations and real SQLite)', () => {
  let directory: string;
  let filename: string;
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    directory = mkdtempSync(join(tmpdir(), 'benchmark-scheduler-'));
    filename = join(directory, 'scheduler.sqlite');
    sqlite = new DatabaseSync(filename);
    applyBenchmarkMigrations(sqlite);
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('1970-01-01T00:00:00.000Z');
    db = sqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('uses safe defaults and rejects a configured budget above the container ceiling', () => {
    expect(schedulerConfig()).toEqual({
      slots: 250,
      modelConcurrency: 12,
      modelLimits: {},
      shares: {
        'efficient/platform': 2,
        'frontier/platform': 2,
        'efficient/user': 1,
        'frontier/user': 1,
      },
    });
    expect(() => schedulerConfig('{"slots":251}')).toThrow();
    expect(() => schedulerConfig('{"slots":0}')).toThrow();
    expect(() => schedulerConfig('{"slots":1.5}')).toThrow();
  });

  it('persists exact variant, repetition and chunk membership idempotently', async () => {
    insertRun(sqlite, 'run');
    const input = {
      runId: 'run',
      entries: [
        { model: 'shared/model', variant: null },
        { model: 'shared/model', variant: 'high' },
      ],
      repetitions: 2,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 2,
    };
    await Promise.all([scheduleRunChunks(db, input), scheduleRunChunks(db, input)]);
    const rows = storedChunks(sqlite);
    expect(rows).toHaveLength(8);
    for (const variant of ['', 'high']) {
      for (const rep of [0, 1]) {
        const chunks = rows.filter(row => row.variant === variant && row.rep === rep);
        expect(chunks.map(row => JSON.parse(row.case_ids))).toEqual([
          ['case-a', 'case-b'],
          ['case-c'],
        ]);
        expect(chunks.map(row => row.id)).toEqual(
          [0, 1].map(chunk => JSON.stringify(['run', 'shared/model', variant, rep, chunk]))
        );
      }
    }
    expect(
      rows.every(row => row.status === 'pending' && row.slot === null && row.token === null)
    ).toBe(true);
    await scheduleRunChunks(db, { ...input, caseIds: ['different-case'] });
    expect(storedChunks(sqlite)).toEqual(rows);
  });

  it('terminates every repetition of one unavailable exact pair without releasing its paid ledger or other work', async () => {
    for (const runId of ['run', 'other-run']) {
      insertRun(sqlite, runId, { purpose: runId === 'other-run' ? 'user' : 'platform' });
      await scheduleRunChunks(db, {
        runId,
        entries: [
          { model: 'shared/model', variant: 'low' },
          { model: 'shared/model', variant: 'high' },
          { model: 'other/model', variant: null },
        ],
        repetitions: 2,
        caseIds: ['case-a', 'case-b', 'case-c'],
        chunkSize: 1,
      });
    }
    const claims = await claimMany(
      db,
      schedulerConfig('{"slots":40,"modelConcurrency":40}'),
      40,
      'unavailable'
    );
    const unavailable = claims.find(
      claim =>
        claim.run_id === 'run' &&
        claim.model === 'shared/model' &&
        claim.variant === 'low' &&
        claim.rep === 0 &&
        claim.chunk === 0
    );
    if (!unavailable) throw new Error('Missing unavailable claim');
    expect(await startChunk(db, unavailable.id, unavailable.token, NOW)).toBe(true);
    const inFlight = claims.find(
      claim =>
        claim.run_id === 'run' &&
        claim.model === unavailable.model &&
        claim.variant === unavailable.variant &&
        claim.rep === 1 &&
        claim.chunk === 0
    );
    const notStarted = claims.find(
      claim =>
        claim.run_id === 'run' &&
        claim.model === unavailable.model &&
        claim.variant === unavailable.variant &&
        claim.rep === 0 &&
        claim.chunk === 2
    );
    if (!inFlight || !notStarted) throw new Error('Missing concurrent exact-pair claims');
    await startChunk(db, inFlight.id, inFlight.token, NOW);
    await startChunk(db, notStarted.id, notStarted.token, NOW);
    expect(await beginPaidCase(db, paidCase(inFlight, 'case-a'), NOW)).toBe(true);
    const deferred = claims.find(
      claim =>
        claim.run_id === 'run' &&
        claim.model === unavailable.model &&
        claim.variant === unavailable.variant &&
        claim.chunk === 1
    );
    if (!deferred) throw new Error('Missing queued exact-pair claim');
    await deferChunk(db, deferred.id, deferred.token, NOW + 30_000);
    expect(await beginPaidCase(db, paidCase(unavailable, 'case-a'), NOW)).toBe(true);
    const unrelated = storedChunks(sqlite).filter(
      row => row.run_id !== 'run' || row.model !== 'shared/model' || row.variant !== 'low'
    );

    await failScheduledEntry(db, unavailable, 'model_not_found');
    const stopped = storedChunks(sqlite).filter(
      row => row.run_id === 'run' && row.model === 'shared/model' && row.variant === 'low'
    );
    expect(stopped).toHaveLength(6);
    expect(stopped.filter(row => row.status === 'failed' && row.slot === null)).toHaveLength(4);
    expect(storedChunk(sqlite, inFlight.id)).toMatchObject({
      status: 'active',
      slot: inFlight.slot,
    });
    expect(storedChunk(sqlite, notStarted.id)).toMatchObject({
      status: 'active',
      slot: notStarted.slot,
    });
    expect(await getPaidCaseStartedAt(db, paidCase(inFlight, 'case-a'))).toBe(NOW);
    expect(await restartPaidCase(db, paidCase(inFlight, 'case-a'), NOW + 1)).toBe(false);
    expect(await beginPaidCase(db, paidCase(notStarted, 'case-c'), NOW)).toBe(false);
    expect(
      storedChunks(sqlite).filter(
        row => row.run_id !== 'run' || row.model !== 'shared/model' || row.variant !== 'low'
      )
    ).toEqual(unrelated);
    expect(
      sqlite
        .prepare(
          'SELECT run_id, model, variant, rep, failure_class FROM run_lane_failures ORDER BY rep'
        )
        .all()
    ).toEqual([
      {
        run_id: 'run',
        model: 'shared/model',
        variant: 'low',
        rep: 0,
        failure_class: 'model_not_found',
      },
      {
        run_id: 'run',
        model: 'shared/model',
        variant: 'low',
        rep: 1,
        failure_class: 'model_not_found',
      },
    ]);
    expect(await getPaidCaseStartedAt(db, paidCase(unavailable, 'case-a'))).toBe(NOW);
    expect(await startChunk(db, unavailable.id, unavailable.token, NOW)).toBe(false);
    expect(await beginPaidCase(db, paidCase(unavailable, 'case-b'), NOW)).toBe(false);
  });

  it('ignores an unavailable-entry cancellation from a stale claim token', async () => {
    insertRun(sqlite, 'run');
    await scheduleRunChunks(db, {
      runId: 'run',
      entries: [{ model: 'shared/model', variant: 'low' }],
      repetitions: 2,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    const [claim] = await claimMany(db, schedulerConfig('{"slots":4}'), 4, 'stale');
    if (!claim) throw new Error('Missing active claim');
    await startChunk(db, claim.id, claim.token, NOW);
    const before = storedChunks(sqlite);
    await failScheduledEntry(db, { ...claim, token: 'replaced-token' }, 'model_not_found');
    expect(storedChunks(sqlite)).toEqual(before);
    expect(sqlite.prepare('SELECT * FROM run_lane_failures').all()).toEqual([]);
  });

  it('caps concurrent queued plus active reservations against persisted slots', async () => {
    insertRun(sqlite, 'run');
    await scheduleRunChunks(db, {
      runId: 'run',
      entries: independentEntries(24),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":7}');
    const claims = await claimMany(db, config, 40, 'initial');
    expect(claims).toHaveLength(7);
    expect(new Set(claims.map(claim => claim.id)).size).toBe(7);
    expect(new Set(claims.map(claim => claim.slot)).size).toBe(7);
    expect(liveChunks(sqlite).map(row => row.slot)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(liveChunks(sqlite).map(row => row.status)).toEqual(Array(7).fill('queued'));
    await Promise.all(claims.slice(0, 3).map(claim => startChunk(db, claim.id, claim.token, NOW)));
    expect(liveChunks(sqlite).filter(row => row.status === 'active')).toHaveLength(3);
    expect(liveChunks(sqlite).filter(row => row.status === 'queued')).toHaveLength(4);
    expect(await claimMany(db, config, 40, 'while-full')).toEqual([]);
    expect(liveChunks(sqlite)).toHaveLength(7);
    expect(storedChunks(sqlite).filter(row => row.status === 'pending')).toHaveLength(17);
  });

  it('reserves at most the actual 250-slot ceiling from one pass', async () => {
    insertRun(sqlite, 'ceiling');
    await scheduleRunChunks(db, {
      runId: 'ceiling',
      entries: independentEntries(260),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const claims = await claimMany(db, schedulerConfig(), 280, 'ceiling');
    expect(claims).toHaveLength(250);
    const live = liveChunks(sqlite);
    expect(live).toHaveLength(250);
    expect(new Set(live.map(row => row.slot)).size).toBe(250);
    expect(Math.min(...claims.map(claim => claim.slot))).toBe(0);
    expect(Math.max(...claims.map(claim => claim.slot))).toBe(249);
    expect(storedChunks(sqlite).filter(row => row.status === 'pending')).toHaveLength(10);
  }, 30_000);

  it('fills one deep lane up to its model cap from a single pass', async () => {
    insertRun(sqlite, 'deep-lane');
    await scheduleRunChunks(db, {
      runId: 'deep-lane',
      entries: [{ model: 'deep/model', variant: '' }],
      repetitions: 1,
      caseIds: Array.from({ length: 12 }, (_, index) => `case-${index}`),
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":8,"modelConcurrency":8}');
    const claims = await claimScheduledChunks(db, config, NOW, 'deep-lane');
    expect(claims).toHaveLength(8);
    expect(claims.map(claim => claim.chunk)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(claims.map(claim => claim.slot)).size).toBe(8);
    expect(await claimScheduledChunks(db, config, NOW, 'deep-lane-full')).toEqual([]);
  });

  it('runs one dispatch pass at a time through the shared lease and releases it', async () => {
    insertRun(sqlite, 'serialized');
    await scheduleRunChunks(db, {
      runId: 'serialized',
      entries: independentEntries(3),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":2}');
    sqlite
      .prepare('UPDATE scheduler_dispatch_lock SET token = ?, lease_until = ? WHERE id = 1')
      .run('another-pass', NOW + SCHEDULER_DISPATCH_LEASE_MS);
    expect(await claimScheduledChunks(db, config, NOW, 'blocked')).toEqual([]);
    expect(liveChunks(sqlite)).toEqual([]);
    expect(
      sqlite.prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1').get()
    ).toEqual({ token: 'another-pass', lease_until: NOW + SCHEDULER_DISPATCH_LEASE_MS });
    const released = await claimMany(
      db,
      config,
      2,
      'after-expiry',
      NOW + SCHEDULER_DISPATCH_LEASE_MS
    );
    expect(released).toHaveLength(2);
    expect(released.map(claim => claim.token)).toEqual(['after-expiry-0', 'after-expiry-0']);
    expect(
      sqlite.prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1').get()
    ).toEqual({ token: null, lease_until: 0 });
  });

  it('takes no dispatch lease while a deploy intent is fresh and resumes once it expires', async () => {
    insertRun(sqlite, 'intent');
    await scheduleRunChunks(db, {
      runId: 'intent',
      entries: independentEntries(2),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":2}');
    sqlite
      .prepare('INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (3, ?, ?)')
      .run('deploy-intent-fixture', NOW + 1_000);
    expect(await claimScheduledChunks(db, config, NOW, 'during-intent')).toEqual([]);
    expect(liveChunks(sqlite)).toEqual([]);
    expect(
      sqlite.prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1').get()
    ).toEqual({ token: null, lease_until: 0 });
    expect(await acquireInitializationLease(db, 'init-during-intent', NOW)).toBe(true);
    expect(await claimScheduledChunks(db, config, NOW + 1_000, 'after-intent')).toHaveLength(2);
  });

  it('claims from a 100k-chunk backlog in one bounded pass', async () => {
    const runs = [
      { id: 'scale-efficient-platform', router: 'efficient', purpose: 'platform' },
      { id: 'scale-frontier-platform', router: 'frontier', purpose: 'platform' },
      { id: 'scale-efficient-user', router: 'efficient', purpose: 'user' },
    ] as const;
    const models = 100;
    const perLaneChunks = 84;
    const insert = sqlite.prepare(`
      INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids)
      VALUES (?, ?, ?, ?, '["deepinfra"]', ?, ?, ?)
    `);
    sqlite.exec('BEGIN');
    for (const run of runs) {
      insertRun(sqlite, run.id, run);
      sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(run.id);
      for (let model = 0; model < models; model++) {
        for (const variant of ['', 'high']) {
          for (const rep of [0, 1]) {
            for (let chunk = 0; chunk < perLaneChunks; chunk++) {
              insert.run(
                JSON.stringify([run.id, `scale/model-${model}`, variant, rep, chunk]),
                run.id,
                `scale/model-${model}`,
                variant,
                rep,
                chunk,
                JSON.stringify([`case-${model}-${chunk}`])
              );
            }
          }
        }
      }
    }
    const assigned = sqlite.prepare(`
      UPDATE scheduler_chunks SET status = 'active', slot = ?, token = 'active',
        lease_until = ? WHERE id = ?
    `);
    let slot = 0;
    for (const run of runs) {
      for (let model = 0; model < 83; model++) {
        assigned.run(
          slot++,
          NOW + SCHEDULER_ACTIVE_LEASE_MS,
          JSON.stringify([run.id, `scale/model-${model}`, '', 0, perLaneChunks - 1])
        );
      }
    }
    sqlite.exec('COMMIT');
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status = 'pending'").get()
    ).toEqual({ n: runs.length * models * 2 * 2 * perLaneChunks - 249 });

    const plan = (sql: string) =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map(row => row.detail)
        .join('\n');
    expect(plan(SCHEDULER_LIVE_SQL)).not.toContain('SCAN scheduler_chunks');
    expect(plan(SCHEDULER_LANE_HEADS_SQL)).not.toContain('SCAN scheduler_chunks');
    expect(plan(SCHEDULER_LANE_HEADS_SQL)).toContain('IX_scheduler_chunks_lane');

    const started = performance.now();
    const claims = await claimScheduledChunks(db, schedulerConfig(), NOW, 'scale');
    const elapsed = performance.now() - started;
    expect(claims).toHaveLength(1);
    expect(claims[0]?.slot).toBe(249);
    expect(elapsed).toBeLessThan(3_000);

    sqlite
      .prepare(
        "UPDATE scheduler_chunks SET status = 'pending', slot = NULL, token = NULL, lease_until = 0 WHERE status IN ('queued', 'active')"
      )
      .run();
    const drainStarted = performance.now();
    const drained = await claimScheduledChunks(
      db,
      schedulerConfig('{"modelConcurrency":250}'),
      NOW,
      'scale-drain'
    );
    const drainElapsed = performance.now() - drainStarted;
    expect(drained).toHaveLength(250);
    expect(new Set(drained.map(claim => claim.slot)).size).toBe(250);
    expect(new Set(drained.map(claim => claim.id)).size).toBe(250);
    expect(drainElapsed).toBeLessThan(3_000);
  }, 120_000);

  it('lets same-token redeliveries resume the executing claim but begin its paid case once', async () => {
    insertRun(sqlite, 'redelivery');
    await scheduleRunChunks(db, {
      runId: 'redelivery',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const [claim] = await claimMany(db, schedulerConfig(), 1, 'delivery');
    if (!claim) throw new Error('Expected a queued claim');
    expect(await startChunk(db, claim.id, 'wrong-token', NOW)).toBe(false);
    expect(storedChunk(sqlite, claim.id).status).toBe('queued');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const resumes = await Promise.all(
      Array.from({ length: 16 }, () => startChunk(db, claim.id, claim.token, NOW + 60_000))
    );
    expect(resumes.every(Boolean)).toBe(true);
    expect(storedChunk(sqlite, claim.id)).toMatchObject({
      status: 'active',
      token: claim.token,
      slot: claim.slot,
      attempts: 1,
      lease_until: NOW + SCHEDULER_ACTIVE_LEASE_MS,
    });
    const admissions = await Promise.all(
      Array.from({ length: 16 }, () => beginPaidCase(db, paidCase(claim, 'case'), NOW + 60_000))
    );
    expect(admissions.filter(Boolean)).toHaveLength(1);
    expect(await claimMany(db, schedulerConfig(), 3, 'duplicate')).toEqual([]);
    expect(await startChunk(db, claim.id, claim.token, NOW + SCHEDULER_ACTIVE_LEASE_MS)).toBe(
      false
    );
  });

  it('allocates weighted 2:2:1 shares across backlogged production lanes', async () => {
    const lanes = [
      { id: 'efficient-platform', router: 'efficient', purpose: 'platform' },
      { id: 'frontier-platform', router: 'frontier', purpose: 'platform' },
      { id: 'efficient-user', router: 'efficient', purpose: 'user' },
    ] as const;
    for (const lane of lanes) {
      insertRun(sqlite, lane.id, lane);
      await scheduleRunChunks(db, {
        runId: lane.id,
        entries: independentEntries(20),
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
    }
    const config = schedulerConfig('{"slots":10,"modelConcurrency":10}');
    await claimMany(db, config, 20, 'fair');
    const live = liveChunks(sqlite);
    expect(live).toHaveLength(10);
    expect(lanes.map(lane => live.filter(row => row.run_id === lane.id).length)).toEqual([4, 4, 2]);
  });

  it('lets a lone lane borrow every idle share and admits an arriving lane on the next release', async () => {
    insertRun(sqlite, 'borrower');
    await scheduleRunChunks(db, {
      runId: 'borrower',
      entries: independentEntries(12),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":5}');
    const borrowed = await claimMany(db, config, 10, 'borrow');
    expect(borrowed).toHaveLength(5);
    expect(liveChunks(sqlite).every(row => row.run_id === 'borrower')).toBe(true);
    insertRun(sqlite, 'arriving', { purpose: 'user' });
    await scheduleRunChunks(db, {
      runId: 'arriving',
      entries: independentEntries(3),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const released = borrowed[0];
    if (!released) throw new Error('Expected a borrowed slot');
    expect(await startChunk(db, released.id, released.token, NOW)).toBe(true);
    await finishChunk(db, released.id, released.token);
    const replacements = await claimMany(db, config, 8, 'arrival');
    expect(replacements).toHaveLength(1);
    expect(replacements[0]).toMatchObject({ run_id: 'arriving', slot: released.slot });
    expect(liveChunks(sqlite)).toHaveLength(5);
  });

  it('honors configured shares rather than hard-coding the default lane ratio', async () => {
    for (const purpose of ['platform', 'user'] as const) {
      insertRun(sqlite, purpose, { purpose });
      await scheduleRunChunks(db, {
        runId: purpose,
        entries: independentEntries(12),
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
    }
    const config = schedulerConfig(
      JSON.stringify({
        slots: 8,
        shares: { 'efficient/platform': 1, 'frontier/platform': 1, 'efficient/user': 3 },
      })
    );
    await claimMany(db, config, 12, 'custom-shares');
    expect(liveChunks(sqlite).filter(row => row.run_id === 'platform')).toHaveLength(2);
    expect(liveChunks(sqlite).filter(row => row.run_id === 'user')).toHaveLength(6);
  });

  it("claims a newer same-share run's idle model before models that already hold slots", async () => {
    insertRun(sqlite, 'user-large', { purpose: 'user' });
    await scheduleRunChunks(db, {
      runId: 'user-large',
      entries: independentEntries(3),
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 1,
    });
    const held = await claimMany(db, schedulerConfig('{"slots":3}'), 3, 'large');
    expect(new Set(held.map(claim => claim.model)).size).toBe(3);
    insertRun(sqlite, 'user-small', {
      purpose: 'user',
      startedAt: new Date(NOW + 60_000).toISOString(),
    });
    await scheduleRunChunks(db, {
      runId: 'user-small',
      entries: [{ model: 'new/model', variant: '' }],
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 1,
    });

    const next = await claimScheduledChunks(db, schedulerConfig('{"slots":4}'), NOW, 'small');

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ run_id: 'user-small', model: 'new/model', chunk: 0 });
  });

  it('lets models that share every catalog provider each reach their own model cap', async () => {
    insertRun(sqlite, 'shared-providers');
    await scheduleRunChunks(db, {
      runId: 'shared-providers',
      entries: [
        { model: 'anthropic/opus', variant: '' },
        { model: 'anthropic/sonnet', variant: '' },
      ],
      repetitions: 1,
      caseIds: Array.from({ length: 20 }, (_, index) => `case-${index}`),
      chunkSize: 1,
    });
    expect(sqlite.prepare('SELECT DISTINCT providers FROM scheduler_chunks').all()).toEqual([
      { providers: '[]' },
    ]);
    // Chunks the previous worker wrote still carry the catalog's whole provider list.
    sqlite
      .prepare(`UPDATE scheduler_chunks SET providers = '["amazon-bedrock","google-vertex"]'`)
      .run();
    const claims = await claimMany(db, schedulerConfig(), 60, 'shared-providers');
    expect(claims).toHaveLength(24);
    for (const model of ['anthropic/opus', 'anthropic/sonnet']) {
      expect(liveChunks(sqlite).filter(row => row.model === model)).toHaveLength(12);
    }
    expect(storedChunks(sqlite).filter(row => row.status === 'pending')).toHaveLength(16);
  });

  it('shares a model cap across variants and separate runs while other models remain runnable', async () => {
    insertRun(sqlite, 'classifier', { kind: 'classifier' });
    insertRun(sqlite, 'decider');
    for (const runId of ['classifier', 'decider']) {
      await scheduleRunChunks(db, {
        runId,
        entries: [
          { model: 'same/model', variant: 'low' },
          { model: 'same/model', variant: 'high' },
          { model: 'other/model', variant: '' },
        ],
        repetitions: 1,
        caseIds: ['case-a', 'case-b'],
        chunkSize: 1,
      });
    }
    const config = schedulerConfig(
      JSON.stringify({
        slots: 8,
        modelConcurrency: 4,
        modelLimits: { 'same/model': 2 },
      })
    );
    const claims = await claimMany(db, config, 20, 'models');
    expect(claims).toHaveLength(6);
    expect(liveChunks(sqlite).filter(row => row.model === 'same/model')).toHaveLength(2);
    expect(liveChunks(sqlite).filter(row => row.model === 'other/model')).toHaveLength(4);
    expect(storedChunks(sqlite).filter(row => row.status === 'pending')).toHaveLength(6);
  });

  it.each(['queued', 'active'] as const)(
    'recovers an expired %s lease and fences its previous token',
    async status => {
      insertRun(sqlite, 'recovery');
      await scheduleRunChunks(db, {
        runId: 'recovery',
        entries: independentEntries(1),
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const config = schedulerConfig('{"slots":1}');
      const [old] = await claimMany(db, config, 1, 'old');
      if (!old) throw new Error('Expected the initial claim');
      const lease = status === 'active' ? SCHEDULER_ACTIVE_LEASE_MS : SCHEDULER_QUEUE_LEASE_MS;
      if (status === 'active') expect(await startChunk(db, old.id, old.token, NOW)).toBe(true);
      expect(await recoverChunks(db, NOW + lease - 1)).toEqual([]);
      expect(storedChunk(sqlite, old.id).status).toBe(status);
      expect(await recoverChunks(db, NOW + lease)).toEqual([]);
      expect(storedChunk(sqlite, old.id)).toMatchObject({
        status: 'pending',
        slot: null,
        token: null,
        lease_until: 0,
        attempts: 1,
      });
      const [replacement] = await claimMany(db, config, 1, 'replacement', NOW + lease);
      if (!replacement) throw new Error('Expected a recovered claim');
      expect(replacement).toMatchObject({ id: old.id, slot: old.slot, attempts: 2 });
      const before = storedChunk(sqlite, old.id);
      expect(await startChunk(db, old.id, old.token, NOW + lease)).toBe(false);
      await finishChunk(db, old.id, old.token);
      await deferChunk(db, old.id, old.token, NOW + lease + 100_000);
      expect(storedChunk(sqlite, old.id)).toEqual(before);
      expect(await startChunk(db, replacement.id, replacement.token, NOW + lease)).toBe(true);
      await finishChunk(db, old.id, old.token);
      await deferChunk(db, old.id, old.token, NOW + lease + 100_000);
      expect(storedChunk(sqlite, old.id).status).toBe('active');
      await finishChunk(db, replacement.id, replacement.token);
      expect(storedChunk(sqlite, old.id)).toMatchObject({
        status: 'completed',
        slot: null,
        lease_until: 0,
      });
    }
  );

  it('continues a lane past a deferred head instead of stalling the whole lane', async () => {
    insertRun(sqlite, 'lane-head');
    await scheduleRunChunks(db, {
      runId: 'lane-head',
      entries: [{ model: 'lane/model', variant: '' }],
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [head] = await claimMany(db, config, 1, 'head');
    if (!head) throw new Error('Expected the lane head');
    expect(head.chunk).toBe(0);
    await deferChunk(db, head.id, head.token, NOW + 60_000);
    const [next] = await claimMany(db, config, 1, 'next');
    expect(next).toMatchObject({ run_id: 'lane-head', chunk: 1, slot: head.slot });
    expect(await claimMany(db, config, 1, 'while-deferred', NOW + 59_000)).toEqual([]);
    expect(await startChunk(db, head.id, head.token, NOW + 60_000)).toBe(false);
  });

  it('releases a deferred slot immediately but does not reclaim that chunk before available_at', async () => {
    insertRun(sqlite, 'deferred');
    await scheduleRunChunks(db, {
      runId: 'deferred',
      entries: independentEntries(2),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'defer');
    if (!claim) throw new Error('Expected a claim to defer');
    const before = storedChunk(sqlite, claim.id);
    await deferChunk(db, claim.id, 'wrong-token', NOW + 1000);
    expect(storedChunk(sqlite, claim.id)).toEqual(before);
    await deferChunk(db, claim.id, claim.token, NOW + 1000);
    expect(storedChunk(sqlite, claim.id)).toMatchObject({
      status: 'pending',
      token: null,
      slot: null,
      available_at: NOW + 1000,
    });
    const [other] = await claimMany(db, config, 1, 'other');
    if (!other) throw new Error('Expected another model to reuse the freed slot');
    expect(other.slot).toBe(claim.slot);
    expect(other.id).not.toBe(claim.id);
    expect(await startChunk(db, other.id, other.token, NOW)).toBe(true);
    await finishChunk(db, other.id, other.token);
    expect(await claimMany(db, config, 1, 'too-soon', NOW + 999)).toEqual([]);
    const [available] = await claimMany(db, config, 1, 'available', NOW + 1000);
    expect(available).toMatchObject({ id: claim.id, attempts: 2, slot: claim.slot });
  });

  it('keeps a throttled chunk claimable past the attempt limit while counting its throttles', async () => {
    insertRun(sqlite, 'throttled');
    await scheduleRunChunks(db, {
      runId: 'throttled',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const throttles = SCHEDULER_MAX_PLATFORM_ATTEMPTS + 2;
    for (let throttle = 1; throttle <= throttles; throttle++) {
      const [claim] = await claimMany(db, config, 1, `throttle-${throttle}`, NOW + throttle);
      if (!claim) throw new Error(`Expected throttled claim ${throttle}`);
      expect(claim.attempts).toBe(1);
      await deferThrottledChunk(db, claim.id, claim.token, NOW + throttle + 1);
    }
    const [stored] = storedChunks(sqlite);
    if (!stored) throw new Error('Expected the throttled chunk');
    expect(stored).toMatchObject({
      status: 'pending',
      attempts: 0,
      throttle_deferrals: throttles,
      slot: null,
      token: null,
    });
    await deferThrottledChunk(db, stored.id, 'stale-token', NOW);
    expect(storedChunks(sqlite)[0]).toEqual(stored);
  });

  it('fails a platform lease reclaim at the second attempt, never a third claim', async () => {
    insertRun(sqlite, 'exhausted');
    await scheduleRunChunks(db, {
      runId: 'exhausted',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    let now = NOW;
    const config = schedulerConfig('{"slots":1}');
    for (let attempt = 1; attempt <= SCHEDULER_MAX_PLATFORM_ATTEMPTS; attempt++) {
      const [claim] = await claimMany(db, config, 1, `attempt-${attempt}`, now);
      if (!claim) throw new Error(`Expected claim attempt ${attempt}`);
      expect(claim.attempts).toBe(attempt);
      now += SCHEDULER_QUEUE_LEASE_MS;
      const failed = await recoverChunks(db, now);
      expect(failed).toHaveLength(attempt === SCHEDULER_MAX_PLATFORM_ATTEMPTS ? 1 : 0);
    }
    expect(storedChunks(sqlite)[0]).toMatchObject({
      status: 'failed',
      slot: null,
      token: null,
      lease_until: 0,
      attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS,
    });
    expect(await claimMany(db, config, 4, 'after-exhaustion', now)).toEqual([]);
    expect(liveChunks(sqlite)).toEqual([]);
  });

  it('re-attempts a user block after a lease loss without spending its billed attempt', async () => {
    insertRun(sqlite, 'user-exhausted', { purpose: 'user' });
    await scheduleRunChunks(db, {
      runId: 'user-exhausted',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    let now = NOW;
    const config = schedulerConfig('{"slots":1}');
    // A lease loss leaves no invocation to report what it spent, so the block returns to the
    // queue and its single BILLED attempt is refunded; the paid ledger fence on the next claim
    // is what prevents a second billed call.
    for (let reclaim = 1; reclaim <= SCHEDULER_MAX_NO_MODEL_REATTEMPTS; reclaim++) {
      const [claim] = await claimMany(db, config, 1, `user-reclaim-${reclaim}`, now);
      if (!claim) throw new Error(`Expected user claim ${reclaim}`);
      expect(claim.attempts).toBe(1);
      now += SCHEDULER_QUEUE_LEASE_MS;
      expect(await recoverChunks(db, now)).toHaveLength(0);
      expect(storedChunks(sqlite)[0]).toMatchObject({
        status: 'pending',
        attempts: 0,
        lease_reclaims: reclaim,
      });
    }
    // The reclaim bound is what keeps a losing block from looping: one more lease loss fails it.
    const [last] = await claimMany(db, config, 1, 'user-reclaim-last', now);
    if (!last) throw new Error('Expected the bounded user claim');
    now += SCHEDULER_QUEUE_LEASE_MS;
    const failed = await recoverChunks(db, now);
    expect(failed).toHaveLength(1);
    expect(storedChunks(sqlite)[0]).toMatchObject({
      status: 'failed',
      attempts: 0,
      lease_reclaims: SCHEDULER_MAX_NO_MODEL_REATTEMPTS + 1,
    });
    expect(await claimMany(db, config, 2, 'after-user-lease', now)).toEqual([]);
  });

  it('fails a platform block on its second ordinary deferral', async () => {
    insertRun(sqlite, 'platform-defer');
    await scheduleRunChunks(db, {
      runId: 'platform-defer',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= SCHEDULER_MAX_PLATFORM_ATTEMPTS; attempt++) {
      const [claim] = await claimMany(db, config, 1, `platform-defer-${attempt}`, NOW + attempt);
      if (!claim) throw new Error(`Expected platform claim ${attempt}`);
      outcomes.push(await deferChunk(db, claim.id, claim.token, NOW + attempt));
    }
    // The first deferral returns the block to the queue; the second spends its last attempt
    // and fails it, so no third claim exists to make a third model call.
    expect(outcomes).toEqual(['deferred', 'failed']);
    expect(storedChunks(sqlite)[0]).toMatchObject({
      status: 'failed',
      attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS,
    });
    expect(await claimMany(db, config, 2, 'after-platform-failure', NOW + 10)).toEqual([]);
  });

  it('fails a user block on its first ordinary deferral, never re-running the model', async () => {
    insertRun(sqlite, 'user-defer', { purpose: 'user' });
    await scheduleRunChunks(db, {
      runId: 'user-defer',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= SCHEDULER_MAX_USER_ATTEMPTS; attempt++) {
      const [claim] = await claimMany(db, config, 1, `user-defer-${attempt}`, NOW + attempt);
      if (!claim) throw new Error(`Expected user claim ${attempt}`);
      outcomes.push(await deferChunk(db, claim.id, claim.token, NOW + attempt));
    }
    // A deferral is the errored block's whole automatic life: its single model call is spent,
    // so the block fails instead of being re-admitted, and only the manual CTA brings it back.
    expect(outcomes).toEqual(['failed']);
    expect(storedChunks(sqlite)[0]).toMatchObject({
      status: 'failed',
      attempts: SCHEDULER_MAX_USER_ATTEMPTS,
    });
    expect(await claimMany(db, config, 2, 'after-user-defer', NOW + 10)).toEqual([]);
  });

  it("refunds a refused retry's attempt and ledger start against a real database", async () => {
    // The refund addresses the chunk by the CLAIM's id: a chunk id is the JSON of the block's
    // position, so binding the run id there matched nothing and silently left the block at its
    // cap. This runs the production helper against real migrations, not mocks.
    insertRun(sqlite, 'refund');
    await scheduleRunChunks(db, {
      runId: 'refund',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'refund-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    // The retry spent its attempt and moved the ledger start, then was refused.
    sqlite.prepare('UPDATE scheduler_chunks SET attempts = 2 WHERE id = ?').run(claim.id);
    const ledgerKey = {
      runId: 'refund',
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      caseId: 'case',
      token: claim.token,
    };
    expect(await beginPaidCase(db, ledgerKey, NOW)).toBe(true);
    const retriedAt = NOW + 1;
    await restartPaidCaseStatement(
      db,
      {
        runId: 'refund',
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        caseId: 'case',
        token: claim.token,
        attemptStartedAt: NOW,
      },
      retriedAt
    ).run();

    await refundUnspentRetryAttempt(db, {
      claim: { id: claim.id, token: claim.token },
      engineIdentity: 'scheduler-storage-test',
      // `execution` carries the attempt's ORIGINAL start; `startedAt` is what the retry
      // wrote. Reverting restores the original, which is what the WHERE clause matches.
      execution: { ...ledgerKey, attemptStartedAt: NOW },
      startedAt: retriedAt,
    });

    expect(storedChunk(sqlite, claim.id).attempts).toBe(1);
    expect(
      sqlite.prepare('SELECT started_at FROM scheduler_executions WHERE case_id = ?').get('case')
    ).toEqual({ started_at: NOW });
  });

  /** Seeds the canonical case run the retry's fence moves, as the production claim does. */
  function seedCanonicalCaseRun(runId: string, claim: SchedulerClaim, startedAt: number): void {
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          executor_run_id, executor_token, platform_covered, result_usable,
          created_at, updated_at, started_at
        ) VALUES (?, ?, ?, ?, 'case', 'running', 1, ?, ?, 1, 0, ?, ?, ?)`
      )
      .run(
        'scheduler-storage-test',
        claim.model,
        claim.variant,
        claim.rep,
        runId,
        claim.token,
        new Date(startedAt).toISOString(),
        new Date(startedAt).toISOString(),
        new Date(startedAt).toISOString()
      );
  }

  const retryStarts = () => ({
    ledger: sqlite
      .prepare('SELECT started_at FROM scheduler_executions WHERE case_id = ?')
      .get('case'),
    canonical: sqlite
      .prepare('SELECT started_at FROM benchmark_case_runs WHERE case_id = ?')
      .get('case'),
  });

  it('leaves both starts untouched when the consume statement refuses the retry', async () => {
    // The retry spends its attempt before it moves either start, so a refused spend means the
    // ledger start and the canonical case-run start were never touched and still agree — which
    // is what RunnerCancel's live check compares.
    insertRun(sqlite, 'refused');
    await scheduleRunChunks(db, {
      runId: 'refused',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'refused-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    expect(
      await beginPaidCase(
        db,
        {
          runId: 'refused',
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId: 'case',
          token: claim.token,
        },
        NOW
      )
    ).toBe(true);
    seedCanonicalCaseRun('refused', claim, NOW);
    sqlite.prepare('UPDATE scheduler_chunks SET attempts = 2 WHERE id = ?').run(claim.id);

    const before = retryStarts();
    // The canonical row really is seeded, so the assertion below is not undefined === undefined.
    expect(before.canonical).toEqual({ started_at: new Date(NOW).toISOString() });

    const consumed = await consumeRetryAttemptStatement(db, claim.id, claim.token, NOW + 1).run();
    expect(consumed.meta.changes).toBe(0);

    expect(retryStarts()).toEqual(before);
    expect(storedChunk(sqlite, claim.id).attempts).toBe(2);
  });

  it('moves both starts to the retry start when the fence accepts it', async () => {
    // The accepting path of the shared guard: a wrong bind order or a predicate that never
    // matches would silently refuse every retry in production, which assertions about
    // refusals alone cannot see. Everything the guard names is valid here.
    insertRun(sqlite, 'accepted');
    await scheduleRunChunks(db, {
      runId: 'accepted',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'accepted-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const ledgerKey = {
      runId: 'accepted',
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      caseId: 'case',
      token: claim.token,
    };
    expect(await beginPaidCase(db, ledgerKey, NOW)).toBe(true);
    seedCanonicalCaseRun('accepted', claim, NOW);
    const before = retryStarts();
    expect(before.canonical).toEqual({ started_at: new Date(NOW).toISOString() });

    const consumed = await consumeRetryAttemptStatement(db, claim.id, claim.token, NOW + 1).run();
    expect(consumed.meta.changes).toBe(1);
    const retriedAt = NOW + 1;
    const restarted = await db.batch([
      restartPaidCaseStatement(db, { ...ledgerKey, attemptStartedAt: NOW }, retriedAt),
      restartPaidCaseRunStatement(db, {
        key: {
          engineIdentity: 'scheduler-storage-test',
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId: 'case',
        },
        executor: { runId: 'accepted', token: claim.token },
        startedAt: retriedAt,
      }),
    ]);

    expect(restarted.map(result => result.meta.changes)).toEqual([1, 1]);
    const retried = retryStarts();
    const ledgerStart = retried.ledger as { started_at: number };
    const canonicalStart = retried.canonical as { started_at: string };
    expect(ledgerStart).toEqual({ started_at: retriedAt });
    expect(canonicalStart).toEqual({ started_at: new Date(retriedAt).toISOString() });
    // Both starts name the same instant, which is what RunnerCancel's live check compares.
    expect(new Date(ledgerStart.started_at).toISOString()).toBe(canonicalStart.started_at);
    // The claim spent one attempt, and the retry spent exactly one more.
    expect(storedChunk(sqlite, claim.id).attempts).toBe(2);
  });

  it('puts both starts back to the first attempt when the retry never reached the model', async () => {
    // The retry's restart batch succeeded, then the retry was refused (container not reached or
    // the launch fence). The refund must restore the ledger start AND the canonical start to
    // the first attempt's, or RunnerCancel's live check compares two different instants.
    insertRun(sqlite, 'refunded');
    await scheduleRunChunks(db, {
      runId: 'refunded',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'refunded-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const ledgerKey = {
      runId: 'refunded',
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      caseId: 'case',
      token: claim.token,
    };
    expect(await beginPaidCase(db, ledgerKey, NOW)).toBe(true);
    seedCanonicalCaseRun('refunded', claim, NOW);
    const before = retryStarts();
    expect(before.canonical).toEqual({ started_at: new Date(NOW).toISOString() });

    // The retry spends its attempt and its restart batch succeeds, moving both starts.
    expect(
      (await consumeRetryAttemptStatement(db, claim.id, claim.token, NOW + 1).run()).meta.changes
    ).toBe(1);
    const retriedAt = NOW + 1;
    const restarted = await db.batch([
      restartPaidCaseStatement(db, { ...ledgerKey, attemptStartedAt: NOW }, retriedAt),
      restartPaidCaseRunStatement(db, {
        key: {
          engineIdentity: 'scheduler-storage-test',
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId: 'case',
        },
        executor: { runId: 'refunded', token: claim.token },
        startedAt: retriedAt,
      }),
    ]);
    expect(restarted.map(result => result.meta.changes)).toEqual([1, 1]);
    expect(retryStarts().canonical).toEqual({ started_at: new Date(retriedAt).toISOString() });

    // The retry is then refused before reaching the model.
    await refundUnspentRetryAttempt(db, {
      claim: { id: claim.id, token: claim.token },
      engineIdentity: 'scheduler-storage-test',
      execution: { ...ledgerKey, attemptStartedAt: NOW },
      startedAt: retriedAt,
    });

    expect(retryStarts()).toEqual(before);
    expect(storedChunk(sqlite, claim.id).attempts).toBe(1);
  });

  it('applies both reverts or neither when the lease expires before the refund', async () => {
    // The canonical revert carries the ledger revert's guard term for term, so a lease that
    // expired between the restart and the refund refuses BOTH: the two starts stay equal (both
    // still at the retry start) instead of the canonical one drifting on its own.
    insertRun(sqlite, 'expired');
    await scheduleRunChunks(db, {
      runId: 'expired',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'expired-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const ledgerKey = {
      runId: 'expired',
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      caseId: 'case',
      token: claim.token,
    };
    expect(await beginPaidCase(db, ledgerKey, NOW)).toBe(true);
    seedCanonicalCaseRun('expired', claim, NOW);
    expect(
      (await consumeRetryAttemptStatement(db, claim.id, claim.token, NOW + 1).run()).meta.changes
    ).toBe(1);
    const retriedAt = NOW + 1;
    const restarted = await db.batch([
      restartPaidCaseStatement(db, { ...ledgerKey, attemptStartedAt: NOW }, retriedAt),
      restartPaidCaseRunStatement(db, {
        key: {
          engineIdentity: 'scheduler-storage-test',
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId: 'case',
        },
        executor: { runId: 'expired', token: claim.token },
        startedAt: retriedAt,
      }),
    ]);
    expect(restarted.map(result => result.meta.changes)).toEqual([1, 1]);
    const atRetry = retryStarts();
    expect(atRetry.canonical).toEqual({ started_at: new Date(retriedAt).toISOString() });

    // The claim's lease expires before the refund runs.
    sqlite.prepare('UPDATE scheduler_chunks SET lease_until = 0 WHERE id = ?').run(claim.id);

    await refundUnspentRetryAttempt(db, {
      claim: { id: claim.id, token: claim.token },
      engineIdentity: 'scheduler-storage-test',
      execution: { ...ledgerKey, attemptStartedAt: NOW },
      startedAt: retriedAt,
    });

    // Both statements refused, so both starts are untouched and still agree.
    expect(retryStarts()).toEqual(atRetry);
    // The attempt refund is guarded by status/token only, so it still returns the spend.
    expect(storedChunk(sqlite, claim.id).attempts).toBe(1);
  });

  it('moves neither start when the run ends between the consume and the restart', async () => {
    // The two restart statements carry the SAME guard, so a fence refusal cannot move only the
    // canonical row: here the consume succeeds, then the run is paused, and the batch's guard
    // refuses both. The retry's refund then restores the attempt and both starts still match.
    insertRun(sqlite, 'paused');
    await scheduleRunChunks(db, {
      runId: 'paused',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'paused-claim', NOW);
    if (!claim) throw new Error('Expected the claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const ledgerKey = {
      runId: 'paused',
      model: claim.model,
      variant: claim.variant,
      rep: claim.rep,
      caseId: 'case',
      token: claim.token,
    };
    expect(await beginPaidCase(db, ledgerKey, NOW)).toBe(true);
    seedCanonicalCaseRun('paused', claim, NOW);
    const before = retryStarts();
    expect(before.canonical).toBeDefined();

    const consumed = await consumeRetryAttemptStatement(db, claim.id, claim.token, NOW + 1).run();
    expect(consumed.meta.changes).toBe(1);
    // The run stops being live between the spend and the fence restart.
    sqlite.prepare("UPDATE benchmark_runs SET status = 'failed' WHERE id = 'paused'").run();
    const restarted = await db.batch([
      restartPaidCaseStatement(db, { ...ledgerKey, attemptStartedAt: NOW }, NOW + 1),
      restartPaidCaseRunStatement(db, {
        key: {
          engineIdentity: 'scheduler-storage-test',
          model: claim.model,
          variant: claim.variant,
          rep: claim.rep,
          caseId: 'case',
        },
        executor: { runId: 'paused', token: claim.token },
        startedAt: NOW + 1,
      }),
    ]);
    expect(restarted.map(result => result.meta.changes)).toEqual([0, 0]);
    expect(retryStarts()).toEqual(before);

    // The refusal refunds the attempt it spent; both starts were never touched.
    await refundUnspentRetryAttempt(db, {
      claim: { id: claim.id, token: claim.token },
      engineIdentity: 'scheduler-storage-test',
      execution: { ...ledgerKey, attemptStartedAt: NOW },
      startedAt: NOW + 1,
    });
    expect(storedChunk(sqlite, claim.id).attempts).toBe(1);
    expect(retryStarts()).toEqual(before);
  });

  it('does not spend a platform attempt on a wait that never reached the model', async () => {
    insertRun(sqlite, 'platform-wait');
    await scheduleRunChunks(db, {
      runId: 'platform-wait',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'wait-claim');
    if (!claim) throw new Error('Expected a claim');
    await deferNoModelCallChunk(db, claim.id, claim.token, NOW);
    expect(storedChunk(sqlite, claim.id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('persists the paid-case guard across connection restart, lease recovery and token replacement', async () => {
    insertRun(sqlite, 'paid');
    await scheduleRunChunks(db, {
      runId: 'paid',
      entries: [{ model: 'paid/model', variant: 'low' }],
      repetitions: 1,
      caseIds: ['paid-case', 'unpaid-case'],
      chunkSize: 2,
    });
    const config = schedulerConfig('{"slots":1}');
    const [claim] = await claimMany(db, config, 1, 'paid');
    if (!claim) throw new Error('Expected the paid chunk');
    const key = paidCase(claim, 'paid-case');
    expect(await beginPaidCase(db, key)).toBe(false);
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    for (const invalid of [
      { ...key, token: 'wrong-token' },
      { ...key, caseId: 'not-in-this-chunk' },
      { ...key, rep: 1 },
      { ...key, variant: 'high' },
      { ...key, model: 'another/model' },
      { ...key, runId: 'another-run' },
    ])
      expect(await beginPaidCase(db, invalid)).toBe(false);
    expect(sqlite.prepare('SELECT * FROM scheduler_executions').all()).toEqual([]);
    const admissions = await Promise.all(Array.from({ length: 16 }, () => beginPaidCase(db, key)));
    expect(admissions.filter(Boolean)).toHaveLength(1);
    expect(sqlite.prepare('SELECT * FROM scheduler_executions').all()).toEqual([
      {
        run_id: 'paid',
        model: claim.model,
        variant: 'low',
        rep: 0,
        case_id: 'paid-case',
        token: claim.token,
        started_at: NOW,
        prompt_revision: 2,
      },
    ]);
    sqlite.close();
    sqlite = new DatabaseSync(filename);
    db = sqliteD1(sqlite);
    expect(await beginPaidCase(db, key)).toBe(false);
    const recoveredAt = NOW + SCHEDULER_ACTIVE_LEASE_MS;
    vi.setSystemTime(recoveredAt);
    expect(await beginPaidCase(db, paidCase(claim, 'unpaid-case'))).toBe(false);
    await recoverChunks(db, recoveredAt);
    const [replacement] = await claimMany(db, config, 1, 'new-paid-token', recoveredAt);
    if (!replacement) throw new Error('Expected the recovered paid chunk');
    expect(await startChunk(db, replacement.id, replacement.token, recoveredAt)).toBe(true);
    expect(await beginPaidCase(db, paidCase(replacement, 'paid-case'))).toBe(false);
    expect(await getPaidCaseStartedAt(db, paidCase(replacement, 'paid-case'))).toBe(NOW);
    expect(await getPaidCaseStartedAt(db, paidCase(replacement, 'unpaid-case'))).toBeNull();
    expect(await beginPaidCase(db, paidCase(replacement, 'unpaid-case'))).toBe(true);
    expect(await beginPaidCase(db, paidCase(claim, 'unpaid-case'))).toBe(false);
    expect(
      sqlite
        .prepare('SELECT case_id, token, started_at FROM scheduler_executions ORDER BY case_id')
        .all()
    ).toEqual([
      { case_id: 'paid-case', token: claim.token, started_at: NOW },
      { case_id: 'unpaid-case', token: replacement.token, started_at: recoveredAt },
    ]);
  });

  it("restarts a ledgered case's paid start only for the token that opened it", async () => {
    insertRun(sqlite, 'restart');
    await scheduleRunChunks(db, {
      runId: 'restart',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const [claim] = await claimMany(db, schedulerConfig(), 1, 'restart');
    if (!claim) throw new Error('Expected a claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const key = paidCase(claim, 'case');
    expect(await beginPaidCase(db, key, NOW)).toBe(true);
    expect(await restartPaidCase(db, { ...key, token: 'another-token' }, NOW + 1_000)).toBe(false);
    expect(await getPaidCaseStartedAt(db, key)).toBe(NOW);
    expect(await restartPaidCase(db, key, NOW + 2_000)).toBe(true);
    expect(await getPaidCaseStartedAt(db, key)).toBe(NOW + 2_000);
    await finishChunk(db, claim.id, claim.token);
    expect(await restartPaidCase(db, key, NOW + 3_000)).toBe(false);
    expect(await getPaidCaseStartedAt(db, key)).toBe(NOW + 2_000);
  });

  it('ledgers the prompt transport that opened a paid case, defaulting to the old one', async () => {
    insertRun(sqlite, 'revision');
    await scheduleRunChunks(db, {
      runId: 'revision',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case', 'legacy'],
      chunkSize: 2,
    });
    const [claim] = await claimMany(db, schedulerConfig(), 1, 'revision');
    if (!claim) throw new Error('Expected a claim');
    expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
    const key = paidCase(claim, 'case');
    const legacy = paidCase(claim, 'legacy');
    expect(await getPaidCasePromptRevision(db, key)).toBeNull();
    expect(await beginPaidCase(db, key, NOW)).toBe(true);
    expect(await getPaidCasePromptRevision(db, key)).toBe(2);
    // A worker deployed before the column existed leaves the default.
    sqlite
      .prepare(`INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        legacy.runId,
        legacy.model,
        legacy.variant,
        legacy.rep,
        legacy.caseId,
        legacy.token,
        NOW
      );
    expect(await getPaidCasePromptRevision(db, legacy)).toBe(1);
  });

  it('keys paid-case admission separately by exact variant and repetition', async () => {
    insertRun(sqlite, 'paid-identities');
    await scheduleRunChunks(db, {
      runId: 'paid-identities',
      entries: [
        { model: 'same/model', variant: 'low' },
        { model: 'same/model', variant: 'high' },
      ],
      repetitions: 2,
      caseIds: ['same-case'],
      chunkSize: 1,
    });
    const claims = await claimMany(db, schedulerConfig(), 8, 'identities');
    expect(claims).toHaveLength(4);
    for (const claim of claims) {
      expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
      expect(await beginPaidCase(db, paidCase(claim, 'same-case'))).toBe(true);
      expect(await beginPaidCase(db, paidCase(claim, 'same-case'))).toBe(false);
    }
    expect(
      sqlite.prepare('SELECT variant, rep FROM scheduler_executions ORDER BY variant, rep').all()
    ).toEqual([
      { variant: 'high', rep: 0 },
      { variant: 'high', rep: 1 },
      { variant: 'low', rep: 0 },
      { variant: 'low', rep: 1 },
    ]);
  });

  it('storage smoke: recycles fast-run slots immediately while a heterogeneous slow chunk stays active', async () => {
    insertRun(sqlite, 'slow');
    insertRun(sqlite, 'fast', { router: 'frontier' });
    await scheduleRunChunks(db, {
      runId: 'slow',
      entries: [{ model: 'slow/model', variant: 'high' }],
      repetitions: 1,
      caseIds: ['slow-a', 'slow-b', 'slow-c', 'slow-d'],
      chunkSize: 4,
    });
    await scheduleRunChunks(db, {
      runId: 'fast',
      entries: independentEntries(6),
      repetitions: 1,
      caseIds: ['fast-case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":3}');
    const initial = await claimMany(db, config, 12, 'smoke-initial');
    expect(initial).toHaveLength(3);
    const slow = initial.find(claim => claim.run_id === 'slow');
    if (!slow) throw new Error('Expected the slow chunk to hold one slot');
    await Promise.all(initial.map(claim => startChunk(db, claim.id, claim.token, NOW)));
    let fast = initial.filter(claim => claim.run_id === 'fast');
    let completed = 0;
    const occupiedCounts = [liveChunks(sqlite).length];
    while (fast.length > 0) {
      for (const claim of fast) {
        expect(await beginPaidCase(db, paidCase(claim, 'fast-case'))).toBe(true);
        await finishChunk(db, claim.id, claim.token);
        completed++;
      }
      const next = await claimMany(db, config, 10, `smoke-refill-${completed}`);
      expect(next.every(claim => claim.run_id === 'fast')).toBe(true);
      expect(next.length).toBe(Math.min(2, 6 - completed));
      expect(storedChunk(sqlite, slow.id)).toMatchObject({
        status: 'active',
        token: slow.token,
        slot: slow.slot,
      });
      occupiedCounts.push(liveChunks(sqlite).length);
      await Promise.all(next.map(claim => startChunk(db, claim.id, claim.token, NOW)));
      fast = next;
    }
    expect(completed).toBe(6);
    expect(occupiedCounts).toEqual([3, 3, 3, 1]);
    expect(
      storedChunks(sqlite).filter(row => row.run_id === 'fast' && row.status === 'completed')
    ).toHaveLength(6);
    expect(sqlite.prepare('SELECT * FROM scheduler_executions').all()).toHaveLength(6);
    expect(liveChunks(sqlite)).toHaveLength(1);
    await finishChunk(db, slow.id, slow.token);
    expect(liveChunks(sqlite)).toEqual([]);
  });

  it.each([
    { status: 'completed', release: 'finish' },
    { status: 'completed', release: 'expiry' },
    { status: 'failed', release: 'finish' },
    { status: 'failed', release: 'expiry' },
  ] as const)(
    'retains terminal $status run accounting until active $release while releasing queued work',
    async ({ status, release }) => {
      insertRun(sqlite, 'terminal');
      await scheduleRunChunks(db, {
        runId: 'terminal',
        entries: [
          { model: 'a/held', variant: '' },
          { model: 'b/queued', variant: '' },
        ],
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const config = schedulerConfig('{"slots":3,"modelConcurrency":1}');
      const initial = await claimMany(db, config, 2, 'terminal');
      const active = initial.find(claim => claim.model === 'a/held');
      const queued = initial.find(claim => claim.model === 'b/queued');
      if (!active || !queued)
        throw new Error('Expected active and queued terminal-run reservations');
      expect(await startChunk(db, active.id, active.token, NOW)).toBe(true);
      const held = storedChunk(sqlite, active.id);
      sqlite.prepare('UPDATE benchmark_runs SET status = ? WHERE id = ?').run(status, 'terminal');
      expect(await beginPaidCase(db, paidCase(active, 'case'))).toBe(false);
      expect(sqlite.prepare('SELECT * FROM scheduler_executions').all()).toEqual([]);
      expect(await recoverChunks(db, NOW + 1)).toEqual([]);
      expect(storedChunk(sqlite, active.id)).toEqual(held);
      expect(storedChunk(sqlite, queued.id)).toMatchObject({
        status: 'completed',
        slot: null,
        token: null,
        lease_until: 0,
      });
      expect(await startChunk(db, queued.id, queued.token, NOW + 1)).toBe(false);
      insertRun(sqlite, 'successor');
      await scheduleRunChunks(db, {
        runId: 'successor',
        entries: [
          { model: 'a/held', variant: 'high' },
          { model: 'c/successor', variant: '' },
          { model: 'd/successor', variant: '' },
          { model: 'e/successor', variant: '' },
        ],
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const successors = await claimMany(db, config, 10, 'successor', NOW + 1);
      expect(successors.map(claim => claim.model).sort()).toEqual(['c/successor', 'd/successor']);
      expect(liveChunks(sqlite)).toHaveLength(3);
      expect(successors.every(claim => claim.slot !== active.slot)).toBe(true);
      let now = NOW + 1;
      if (release === 'finish') {
        await finishChunk(db, active.id, active.token);
      } else {
        now = NOW + SCHEDULER_ACTIVE_LEASE_MS;
        expect(await recoverChunks(db, now - 1)).toEqual([]);
        expect(storedChunk(sqlite, active.id)).toEqual(held);
        expect(await recoverChunks(db, now)).toEqual([]);
      }
      expect(storedChunk(sqlite, active.id)).toMatchObject({
        status: 'completed',
        slot: null,
        lease_until: 0,
      });
      const [reused] = await claimMany(db, config, 5, 'terminal-release', now);
      expect(reused).toMatchObject({ model: 'a/held', variant: 'high', slot: active.slot });
      expect(liveChunks(sqlite)).toHaveLength(3);
    }
  );

  it('completes fully reused chunks before the initialization marker while leaving partial exact identities pending', async () => {
    insertRun(sqlite, 'reuse');
    insertRun(sqlite, 'prior', { router: 'frontier' });
    sqlite.prepare("UPDATE benchmark_runs SET status = 'completed' WHERE id = 'prior'").run();
    const result = sqlite.prepare(`
      INSERT INTO case_results (run_id, model, variant, case_id, rep, score, latency_ms)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `);
    for (const caseId of ['full-a', 'full-b', 'partial-a']) {
      result.run('reuse', 'shared/model', 'low', caseId, 0);
    }
    result.run('reuse', 'shared/model', 'high', 'full-a', 0);
    result.run('reuse', 'shared/model', 'low', 'full-a', 1);
    for (const caseId of ['missing-a', 'missing-b']) {
      result.run('prior', 'shared/model', 'low', caseId, 0);
      result.run('reuse', 'another/model', 'low', caseId, 0);
    }
    sqlite.exec(`
      CREATE TRIGGER reused_chunk_completed_before_init
      BEFORE INSERT ON scheduler_runs
      WHEN NEW.run_id = 'reuse' AND NOT EXISTS (
        SELECT 1 FROM scheduler_chunks
        WHERE run_id = 'reuse' AND model = 'shared/model' AND variant = 'low'
          AND rep = 0 AND chunk = 0 AND status = 'completed'
      )
      BEGIN
        SELECT RAISE(ABORT, 'Fully reused chunk was not completed before scheduler initialization');
      END;
    `);
    await scheduleRunChunks(db, {
      runId: 'reuse',
      entries: [
        { model: 'shared/model', variant: 'low' },
        { model: 'shared/model', variant: 'high' },
      ],
      repetitions: 2,
      caseIds: ['full-a', 'full-b', 'partial-a', 'partial-b', 'missing-a', 'missing-b'],
      chunkSize: 2,
    });
    const rows = storedChunks(sqlite);
    expect(rows).toHaveLength(12);
    const completed = rows.filter(row => row.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      run_id: 'reuse',
      model: 'shared/model',
      variant: 'low',
      rep: 0,
      chunk: 0,
      slot: null,
    });
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(11);
    expect(sqlite.prepare('SELECT * FROM scheduler_runs').all()).toEqual([{ run_id: 'reuse' }]);
    const claims = await claimMany(
      db,
      schedulerConfig('{"slots":20,"modelConcurrency":20}'),
      20,
      'reuse'
    );
    expect(claims).toHaveLength(11);
    expect(claims.some(claim => claim.id === completed[0]?.id)).toBe(false);
    expect(
      claims.find(claim => claim.variant === 'low' && claim.rep === 0 && claim.chunk === 1)
        ?.case_ids
    ).toBe('["partial-a","partial-b"]');
    expect(
      claims.find(claim => claim.variant === 'low' && claim.rep === 0 && claim.chunk === 2)
        ?.case_ids
    ).toBe('["missing-a","missing-b"]');
  });

  it('bounds materialization reads by the chunk and the run instead of the backlog', () => {
    const insertPlan = explainPlan(sqlite, SCHEDULER_INSERT_CHUNK_SQL);
    expect(insertPlan).toContain(
      'SEARCH case_results USING COVERING INDEX sqlite_autoindex_case_results_1 (run_id=? AND model=? AND variant=? AND case_id=? AND rep=?)'
    );
    expect(insertPlan).not.toContain('SCAN case_results');
    // Materialization stays one insert per row: the block guard is a run-scoped read done
    // once per pass, not a per-row scan over the chunk table.
    expect(insertPlan).not.toContain('scheduler_chunks');
    const lanesPlan = explainPlan(sqlite, SCHEDULER_MATERIALIZED_LANES_SQL);
    expect(lanesPlan).toContain(
      'SEARCH scheduler_chunks USING INDEX IX_scheduler_chunks_run_id (run_id=?)'
    );
    expect(lanesPlan).not.toContain('SCAN scheduler_chunks');
  });

  it('terminalizes a pending block already over its cap, for a platform and a user run', async () => {
    // Rows an earlier build wrote can be `pending` at or above the cap this build enforces:
    // `claimScheduledChunks` refuses them, so nothing would retire them and their run would hold
    // a queue slot (and a paid request) forever. The recovery pass moves them to `failed`, which
    // is where the lane-failure record and run finalization pick them up — the same terminal
    // state the cap path produces, with no deploy script involved.
    for (const purpose of ['platform', 'user'] as const) {
      const runId = `over-cap-${purpose}`;
      insertRun(sqlite, runId, { purpose });
      await scheduleRunChunks(db, {
        runId,
        entries: [
          { model: 'over/model', variant: '' },
          { model: 'normal/model', variant: '' },
        ],
        repetitions: 1,
        caseIds: ['case-a'],
        chunkSize: 1,
      });
      // The old six-attempt rule left this block at 3 attempts.
      sqlite
        .prepare(
          "UPDATE scheduler_chunks SET attempts = 3 WHERE run_id = ? AND model = 'over/model'"
        )
        .run(runId);

      // It is not selectable, so a dispatch pass takes only the healthy block — and the run is
      // still unsettled, which is exactly the wedge the recovery pass has to clear.
      const claims = await claimMany(db, schedulerConfig('{"slots":4}'), 4, `pre-${purpose}`, NOW);
      expect(claims.map(claim => claim.model)).toEqual(['normal/model']);
      expect(await hasUnsettledChunks(db, runId)).toBe(true);

      const failed = await recoverChunks(db, NOW + 1);

      expect(
        sqlite
          .prepare("SELECT status FROM scheduler_chunks WHERE run_id = ? AND model = 'over/model'")
          .get(runId)
      ).toEqual({ status: 'failed' });
      // Reported once for the lane-failure record, which is what lets the run finish.
      expect(failed.filter(row => row.run_id === runId).map(row => row.model)).toEqual([
        'over/model',
      ]);
      // Dispatch records the lane failure from that report; the next pass then has nothing to
      // re-report, so a terminal block is never revisited.
      sqlite
        .prepare(
          `INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, failed_at, failure_class)
          VALUES (?, 'over/model', '', 0, 0, ?, 'unknown')`
        )
        .run(runId, new Date(NOW).toISOString());
      expect(await recoverChunks(db, NOW + 2)).toEqual([]);
      // The healthy block completes normally and the run has nothing unsettled left.
      const healthyClaim = claims[0];
      if (!healthyClaim) throw new Error('Expected the healthy claim');
      expect(await startChunk(db, healthyClaim.id, healthyClaim.token, NOW + 1)).toBe(true);
      await finishChunk(db, healthyClaim.id, healthyClaim.token);
      expect(await hasUnsettledChunks(db, runId)).toBe(false);
    }
  });

  it('does not repeatedly report failed chunks from lanes already recorded in run_lane_failures', async () => {
    insertRun(sqlite, 'failed-lanes');
    await scheduleRunChunks(db, {
      runId: 'failed-lanes',
      entries: [
        { model: 'shared/model', variant: 'low' },
        { model: 'shared/model', variant: 'high' },
      ],
      repetitions: 2,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'failed', attempts = ?")
      .run(SCHEDULER_MAX_PLATFORM_ATTEMPTS);
    const recordFailure = sqlite.prepare(`
      INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, failed_at)
      VALUES ('failed-lanes', 'shared/model', ?, ?, 0, ?)
    `);
    recordFailure.run('low', 0, new Date(NOW).toISOString());
    recordFailure.run('high', 1, new Date(NOW).toISOString());
    const failed = await recoverChunks(db, NOW);
    expect(failed.map(claim => claim.id).sort()).toEqual(
      [
        JSON.stringify(['failed-lanes', 'shared/model', 'high', 0, 0]),
        JSON.stringify(['failed-lanes', 'shared/model', 'high', 0, 1]),
        JSON.stringify(['failed-lanes', 'shared/model', 'low', 1, 0]),
        JSON.stringify(['failed-lanes', 'shared/model', 'low', 1, 1]),
      ].sort()
    );
    expect(storedChunks(sqlite).filter(row => row.status === 'failed')).toHaveLength(8);
    recordFailure.run('low', 1, new Date(NOW).toISOString());
    recordFailure.run('high', 0, new Date(NOW).toISOString());
    expect(await recoverChunks(db, NOW)).toEqual([]);
    expect(storedChunks(sqlite).filter(row => row.status === 'failed')).toHaveLength(8);
  });

  it('cools only the throttled model across runs, even where other models share its providers', async () => {
    insertRun(sqlite, 'a-cooldown');
    await scheduleRunChunks(db, {
      runId: 'a-cooldown',
      entries: [
        { model: 'a/throttled', variant: 'high' },
        { model: 'a/throttled', variant: 'low' },
        { model: 'b/same-providers', variant: '' },
        { model: 'c/same-providers', variant: '' },
      ],
      repetitions: 1,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [throttled] = await claimMany(db, config, 1, 'throttled');
    if (!throttled) throw new Error('Expected the throttled chunk');
    expect(throttled).toMatchObject({ model: 'a/throttled', variant: 'high' });
    insertRun(sqlite, 'z-other-run', { router: 'frontier' });
    await scheduleRunChunks(db, {
      runId: 'z-other-run',
      entries: [
        { model: 'a/throttled', variant: 'high' },
        { model: 'z/same-providers', variant: '' },
      ],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 1,
    });
    // Rows and a provider cooldown the previous worker wrote.
    sqlite.prepare(`UPDATE scheduler_chunks SET providers = '["deepinfra","fireworks"]'`).run();
    const until = NOW + 1000;
    sqlite
      .prepare("INSERT INTO scheduler_cooldowns (scope, key, until) VALUES ('provider', ?, ?)")
      .run('deepinfra', until);
    await cooldownModel(db, throttled.model, until);
    const cooldowns = () =>
      sqlite.prepare('SELECT scope, key, until FROM scheduler_cooldowns ORDER BY scope, key').all();
    expect(cooldowns()).toEqual([
      { scope: 'model', key: 'a/throttled', until },
      { scope: 'provider', key: 'deepinfra', until },
    ]);
    // The throttled chunk keeps its own schedule: cooling is a dispatch filter, not
    // a rewrite of every pending row that shares the model.
    expect(storedChunks(sqlite).every(row => row.available_at === 0)).toBe(true);
    await cooldownModel(db, throttled.model, NOW + 500);
    expect(cooldowns()).toEqual([
      { scope: 'model', key: 'a/throttled', until },
      { scope: 'provider', key: 'deepinfra', until },
    ]);
    expect(await startChunk(db, throttled.id, throttled.token, NOW)).toBe(true);
    await finishChunk(db, throttled.id, throttled.token);
    const unthrottled: string[] = [];
    for (let index = 0; index < 5; index++) {
      const [claim] = await claimMany(db, config, 1, `unthrottled-${index}`);
      if (!claim) throw new Error('Expected models sharing the providers to remain runnable');
      unthrottled.push(claim.model);
      expect(await startChunk(db, claim.id, claim.token, NOW)).toBe(true);
      await finishChunk(db, claim.id, claim.token);
    }
    expect(unthrottled.sort()).toEqual([
      'b/same-providers',
      'b/same-providers',
      'c/same-providers',
      'c/same-providers',
      'z/same-providers',
    ]);
    expect(await claimMany(db, config, 3, 'cooldown-wait', until - 1)).toEqual([]);
    const available = await claimMany(db, config, 1, 'cooldown-elapsed', until);
    expect(available.map(claim => claim.model)).toEqual(['a/throttled']);
    expect(await recoverChunks(db, until)).toEqual([]);
    expect(cooldowns()).toEqual([]);
  });

  it('clears only the exact unbilled admission token and cannot erase its replacement admission', async () => {
    insertRun(sqlite, 'unbilled');
    await scheduleRunChunks(db, {
      runId: 'unbilled',
      entries: [{ model: 'paid/model', variant: 'low' }],
      repetitions: 1,
      caseIds: ['unbilled-case', 'other-case'],
      chunkSize: 2,
    });
    const config = schedulerConfig('{"slots":1}');
    const [original] = await claimMany(db, config, 1, 'original-admission');
    if (!original) throw new Error('Expected the unbilled admission chunk');
    expect(await startChunk(db, original.id, original.token, NOW)).toBe(true);
    const key = paidCase(original, 'unbilled-case');
    expect(await beginPaidCase(db, key)).toBe(true);
    expect(await beginPaidCase(db, paidCase(original, 'other-case'))).toBe(true);
    const before = sqlite.prepare('SELECT * FROM scheduler_executions ORDER BY case_id').all();
    for (const invalid of [
      { ...key, token: 'another-token' },
      { ...key, caseId: 'another-case' },
      { ...key, variant: 'high' },
      { ...key, rep: 1 },
      { ...key, model: 'another/model' },
      { ...key, runId: 'another-run' },
    ])
      await clearUnbilledCase(db, invalid);
    expect(sqlite.prepare('SELECT * FROM scheduler_executions ORDER BY case_id').all()).toEqual(
      before
    );
    expect(await beginPaidCase(db, key)).toBe(false);
    await clearUnbilledCase(db, key);
    expect(sqlite.prepare('SELECT case_id FROM scheduler_executions').all()).toEqual([
      { case_id: 'other-case' },
    ]);
    expect(await beginPaidCase(db, key)).toBe(true);
    const now = NOW + SCHEDULER_ACTIVE_LEASE_MS;
    vi.setSystemTime(now);
    await recoverChunks(db, now);
    const [replacement] = await claimMany(db, config, 1, 'replacement-admission', now);
    if (!replacement) throw new Error('Expected a replacement chunk admission');
    expect(await startChunk(db, replacement.id, replacement.token, now)).toBe(true);
    const replacementKey = paidCase(replacement, 'unbilled-case');
    await clearUnbilledCase(db, replacementKey);
    expect(await beginPaidCase(db, replacementKey)).toBe(false);
    await clearUnbilledCase(db, key);
    expect(await beginPaidCase(db, replacementKey)).toBe(true);
    const replaced = sqlite
      .prepare('SELECT case_id, token FROM scheduler_executions ORDER BY case_id')
      .all();
    expect(replaced).toEqual([
      { case_id: 'other-case', token: original.token },
      { case_id: 'unbilled-case', token: replacement.token },
    ]);
    await clearUnbilledCase(db, key);
    expect(
      sqlite.prepare('SELECT case_id, token FROM scheduler_executions ORDER BY case_id').all()
    ).toEqual(replaced);
    expect(await beginPaidCase(db, replacementKey)).toBe(false);
  });

  it('DLQ deferral releases queued work but cannot revoke the same token after it starts', async () => {
    insertRun(sqlite, 'dlq');
    await scheduleRunChunks(db, {
      runId: 'dlq',
      entries: independentEntries(1),
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const [queued] = await claimMany(db, schedulerConfig(), 1, 'dlq-queued');
    if (!queued) throw new Error('Expected queued claim');
    await deferChunk(db, queued.id, queued.token, NOW, true);
    expect(storedChunk(sqlite, queued.id).status).toBe('pending');
    const [active] = await claimMany(db, schedulerConfig(), 1, 'dlq-active');
    if (!active) throw new Error('Expected replacement claim');
    expect(await startChunk(db, active.id, active.token, NOW)).toBe(true);
    await deferChunk(db, active.id, active.token, NOW, true);
    expect(storedChunk(sqlite, active.id)).toMatchObject({ status: 'active', token: active.token });
  });

  it('prunes day-old terminal scheduler state without deleting reusable measurements or outputs', async () => {
    for (const [runId, age] of [
      ['old', 2 * 86400_000],
      ['recent', 3600_000],
    ] as const) {
      insertRun(sqlite, runId);
      await scheduleRunChunks(db, {
        runId,
        entries: independentEntries(1),
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const [claim] = await claimMany(db, schedulerConfig(), 1, runId);
      if (!claim) throw new Error('Expected claim');
      await startChunk(db, claim.id, claim.token, NOW);
      await beginPaidCase(db, paidCase(claim, 'case'));
      await finishChunk(db, claim.id, claim.token);
      sqlite
        .prepare(`INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, rep, timed_out)
        VALUES (?, ?, '', 'measured', 1, 12, 0, 0)`)
        .run(runId, claim.model);
      sqlite
        .prepare(`INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload)
        VALUES (?, ?, '', 'ungraded', 0, '{}')`)
        .run(runId, claim.model);
      sqlite
        .prepare("UPDATE benchmark_runs SET status = 'completed', completed_at = ? WHERE id = ?")
        .run(new Date(NOW - age).toISOString(), runId);
    }
    await recoverChunks(db, NOW);
    expect(storedChunks(sqlite).map(row => row.run_id)).toEqual(['recent']);
    expect(sqlite.prepare('SELECT run_id FROM scheduler_executions').all()).toEqual([
      { run_id: 'recent' },
    ]);
    expect(sqlite.prepare('SELECT run_id FROM scheduler_runs').all()).toEqual([
      { run_id: 'recent' },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM case_results').get()?.n).toBe(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_decider_outputs').get()?.n).toBe(2);
  });

  it('prunes the chunks of a terminal run that stopped before its scheduler marker', async () => {
    const insertChunk = sqlite.prepare(`
      INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
      VALUES (?, ?, 'unmarked/model', '', '[]', 0, ?, '["case"]', ?)`);
    for (const [runId, status, completedAt] of [
      ['unmarked-old', 'failed', new Date(NOW - 2 * 86400_000).toISOString()],
      ['unmarked-recent', 'failed', new Date(NOW - 3600_000).toISOString()],
      ['unmarked-running', 'running', null],
    ] as const) {
      insertRun(sqlite, runId);
      sqlite
        .prepare('UPDATE benchmark_runs SET status = ?, completed_at = ? WHERE id = ?')
        .run(status, completedAt, runId);
      for (const [chunk, chunkStatus] of ['completed', 'failed', 'pending'].entries()) {
        insertChunk.run(JSON.stringify([runId, chunk]), runId, chunk, chunkStatus);
      }
    }

    await recoverChunks(db, NOW);

    expect(storedChunks(sqlite).map(row => [row.run_id, row.status])).toEqual([
      ['unmarked-recent', 'completed'],
      ['unmarked-recent', 'failed'],
      ['unmarked-recent', 'completed'],
      ['unmarked-running', 'completed'],
      ['unmarked-running', 'failed'],
      ['unmarked-running', 'pending'],
    ]);
  });

  it('prunes a markerless run the stale sweep failed without a completion time', async () => {
    const insertChunk = sqlite.prepare(`
      INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
      VALUES (?, ?, 'stale/model', '', '[]', 0, ?, '["case"]', ?)`);
    for (const [runId, startedAgo, purpose] of [
      ['stale-day-old', 2 * 86400_000, 'platform'],
      ['stale-hours-old', 7 * 3600_000, 'user'],
    ] as const) {
      insertRun(sqlite, runId, { purpose });
      sqlite
        .prepare('UPDATE benchmark_runs SET started_at = ? WHERE id = ?')
        .run(new Date(NOW - startedAgo).toISOString(), runId);
      for (const [chunk, chunkStatus] of ['completed', 'failed', 'pending'].entries()) {
        insertChunk.run(JSON.stringify([runId, chunk]), runId, chunk, chunkStatus);
      }
    }
    await markStaleRunsFailed(db, new Date(NOW - 6 * 3600_000).toISOString());
    expect(
      sqlite.prepare('SELECT id, status, completed_at FROM benchmark_runs ORDER BY id').all()
    ).toEqual([
      { id: 'stale-day-old', status: 'failed', completed_at: null },
      { id: 'stale-hours-old', status: 'failed', completed_at: null },
    ]);

    await recoverChunks(db, NOW);

    expect(storedChunks(sqlite).map(row => [row.run_id, row.status])).toEqual([
      ['stale-hours-old', 'completed'],
      ['stale-hours-old', 'failed'],
      ['stale-hours-old', 'completed'],
    ]);
  });

  it('reads recovery and prune state from running runs, markers and chunk owners', () => {
    const failedPlan = explainPlan(sqlite, SCHEDULER_UNRECORDED_FAILED_CHUNKS_SQL);
    expect(failedPlan).toContain(
      'SEARCH chunk USING INDEX IX_scheduler_chunks_lane (status=? AND run_id=?)'
    );
    expect(failedPlan).toContain('SCAN run USING INDEX IX_benchmark_runs_running');
    for (const sql of [SCHEDULER_PRUNE_EXECUTIONS_SQL, SCHEDULER_PRUNE_MARKERS_SQL]) {
      const plan = explainPlan(sqlite, sql);
      expect(plan).toContain('SCAN marker');
      expect(plan).toContain('SEARCH run USING INDEX sqlite_autoindex_benchmark_runs_1 (id=?)');
      expect(plan).not.toMatch(/^SCAN run$/m);
    }
    const chunksPlan = explainPlan(sqlite, SCHEDULER_PRUNE_CHUNKS_SQL);
    expect(chunksPlan).toContain(
      'SEARCH c USING COVERING INDEX IX_scheduler_chunks_run_id (run_id>?)'
    );
    expect(chunksPlan).toContain('SEARCH run USING INDEX sqlite_autoindex_benchmark_runs_1 (id=?)');
    expect(chunksPlan).not.toMatch(/^SCAN run$/m);
  });

  it('completes only terminal runs when reclaiming stalled chunks', async () => {
    for (const [runId, status, purpose] of [
      ['running-backlog', 'running', 'platform'],
      ['completed-backlog', 'completed', 'user'],
    ] as const) {
      insertRun(sqlite, runId, { purpose });
      await scheduleRunChunks(db, {
        runId,
        entries: independentEntries(4),
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      sqlite
        .prepare('UPDATE benchmark_runs SET status = ?, completed_at = ? WHERE id = ?')
        .run(
          status,
          status === 'running' ? null : new Date(NOW - 5 * 86400_000).toISOString(),
          runId
        );
    }
    await recoverChunks(db, NOW);
    expect(
      storedChunks(sqlite)
        .filter(row => row.run_id === 'running-backlog')
        .every(row => row.status === 'pending')
    ).toBe(true);
    expect(
      storedChunks(sqlite)
        .filter(row => row.run_id === 'completed-backlog')
        .every(row => row.status === 'completed')
    ).toBe(true);
  });

  it('reports settled work without reading run case results', async () => {
    insertRun(sqlite, 'settle');
    sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run('settle');
    const insertChunk = sqlite.prepare(`
      INSERT INTO scheduler_chunks (id, run_id, model, variant, providers, rep, chunk, case_ids,
        status, slot, token, lease_until)
      VALUES (?, 'settle', ?, ?, '["deepinfra"]', 0, ?, ?, ?, ?, ?, ?)`);
    const insertResult = sqlite.prepare(`
      INSERT INTO case_results (run_id, model, variant, case_id, score, latency_ms, rep, timed_out)
      VALUES ('settle', ?, ?, ?, 1, 10, 0, 0)`);
    sqlite.exec('BEGIN');
    for (let model = 0; model < 100; model++) {
      for (const variant of ['', 'high']) {
        for (let chunk = 0; chunk < 250; chunk++) {
          const live = model === 0 && variant === '';
          insertChunk.run(
            JSON.stringify(['settle', `settle/model-${model}`, variant, chunk]),
            `settle/model-${model}`,
            variant,
            chunk,
            JSON.stringify([`case-${chunk}`]),
            live ? 'active' : 'pending',
            live ? chunk : null,
            live ? 'live-token' : null,
            live ? NOW + SCHEDULER_ACTIVE_LEASE_MS : 0
          );
          insertResult.run(`settle/model-${model}`, variant, `case-${chunk}`);
        }
      }
    }
    sqlite.exec('COMMIT');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM case_results').get()?.n).toBe(50_000);

    expect(explainPlan(sqlite, SCHEDULER_UNSETTLED_SQL)).toContain('IX_scheduler_chunks_lane');
    expect(explainPlan(sqlite, SCHEDULER_UNSETTLED_SQL)).not.toContain('SCAN scheduler_chunks');
    expect(explainPlan(sqlite, SCHEDULER_SETTLED_RUNS_SQL)).not.toContain('SCAN scheduler_chunks');
    expect(explainPlan(sqlite, SCHEDULER_SETTLED_RUNS_SQL)).not.toContain('SCAN run_lane_failures');

    const recorded: string[] = [];
    const wrapped = recordingD1(db, recorded);
    const started = performance.now();
    const unsettled = await hasUnsettledChunks(wrapped, 'settle');
    const elapsed = performance.now() - started;
    expect(unsettled).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded.filter(sql => /case_results/i.test(sql))).toEqual([]);
    expect(elapsed).toBeLessThan(50);

    sqlite.prepare("UPDATE scheduler_chunks SET status = 'completed'").run();
    expect(await hasUnsettledChunks(db, 'settle')).toBe(false);
    expect(await hasUnsettledChunks(db, 'legacy-run-without-chunks')).toBe(false);
  });

  it('ignores chunks of a dead-lettered lane when deciding whether work has settled', async () => {
    insertRun(sqlite, 'dead-lane-settle');
    await scheduleRunChunks(db, {
      runId: 'dead-lane-settle',
      entries: [
        { model: 'dead/model', variant: '' },
        { model: 'live/model', variant: '' },
      ],
      repetitions: 1,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    sqlite
      .prepare(`INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at)
        VALUES ('dead-lane-settle', 'dead/model', '', 0, 0, 0, ?)`)
      .run(new Date(NOW).toISOString());
    expect(await hasUnsettledChunks(db, 'dead-lane-settle')).toBe(true);
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'completed' WHERE model = 'live/model'")
      .run();
    expect(await hasUnsettledChunks(db, 'dead-lane-settle')).toBe(false);
    expect(
      storedChunks(sqlite)
        .filter(row => row.model === 'dead/model')
        .map(row => row.status)
    ).toEqual(['pending', 'pending']);
    sqlite
      .prepare(
        "UPDATE scheduler_chunks SET status = 'active', slot = 0, lease_until = ? WHERE model = 'dead/model' AND chunk = 0"
      )
      .run(NOW + SCHEDULER_ACTIVE_LEASE_MS);
    expect(await hasUnsettledChunks(db, 'dead-lane-settle')).toBe(true);
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'failed', slot = NULL WHERE status = 'active'")
      .run();
    expect(await hasUnsettledChunks(db, 'dead-lane-settle')).toBe(false);
  });
});

/**
 * The automatic-attempt cap is keyed on the chunk row, so the proof that a platform block
 * cannot exceed two calls reduces to: a block (run, model, variant, rep, case) always lands
 * in the same chunk id, in a run that is never re-opened, and the row is never pruned and
 * re-created. These tests replay every path that could break that.
 */
describe('platform attempt cap — a block can never be re-chunked with a fresh counter', () => {
  let directory: string;
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    directory = mkdtempSync(join(tmpdir(), 'benchmark-retry-cap-'));
    sqlite = new DatabaseSync(join(directory, 'scheduler.sqlite'));
    applyBenchmarkMigrations(sqlite);
    sqlite
      .prepare('INSERT INTO benchmark_cutover (id, cutover_at) VALUES (1, ?)')
      .run('1970-01-01T00:00:00.000Z');
    db = sqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  /** Drives one platform block to its failed terminal state and returns its chunk id. */
  async function exhaustOneBlock(runId: string, caseId: string): Promise<string> {
    await scheduleRunChunks(db, {
      runId,
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds: [caseId],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    for (let attempt = 1; attempt <= SCHEDULER_MAX_PLATFORM_ATTEMPTS; attempt++) {
      const [claim] = await claimMany(
        db,
        config,
        1,
        `${runId}-${caseId}-${attempt}`,
        NOW + attempt
      );
      if (!claim) throw new Error(`Expected claim ${attempt} for ${caseId}`);
      expect(claim.case_ids).toBe(JSON.stringify([caseId]));
      await deferChunk(db, claim.id, claim.token, NOW + attempt);
    }
    const row = storedChunks(sqlite).find(chunk => chunk.run_id === runId);
    if (!row) throw new Error('Expected the exhausted chunk');
    expect(row).toMatchObject({ status: 'failed', attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS });
    return row.id;
  }

  it('keeps the same chunk id and counter when initialization is replayed after a failure', async () => {
    insertRun(sqlite, 'replay');
    const id = await exhaustOneBlock('replay', 'case-a');

    // Dead-letter's legacy branch and every dispatch retry call initializeScheduledRun again.
    // The chunk id is derived from the run and the block's position, and the insert is
    // ON CONFLICT (id) DO NOTHING, so the replay neither recreates the row nor resets it.
    await scheduleRunChunks(db, {
      runId: 'replay',
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 1,
    });
    expect(storedChunks(sqlite).find(row => row.id === id)).toMatchObject({
      status: 'failed',
      attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS,
    });
    expect(storedChunks(sqlite)).toHaveLength(1);
    expect(
      await claimMany(db, schedulerConfig('{"slots":1}'), 2, 'replay-after', NOW + 10)
    ).toEqual([]);
  });

  it('keeps the cap when a changed plan moves a block to a different chunk id', async () => {
    // A user lane's cases come from its paid request plan, which can reorder between
    // initialization passes. The chunk id is the block's position in that lane, so a moved
    // case would otherwise land in a brand-new row with `attempts` back at 0 — a fresh budget
    // for the same block. The initializer refuses a second row for a block that already has
    // one, so the cap stays a property of the block (run, model, variant, rep, case set).
    insertRun(sqlite, 'moved', { purpose: 'user' });
    const block = { model: 'cap/model', variant: '' };
    await scheduleRunChunks(db, {
      runId: 'moved',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    const before = storedChunks(sqlite).map(row => [row.id, row.case_ids]);
    expect(before).toEqual([
      [JSON.stringify(['moved', 'cap/model', '', 0, 0]), JSON.stringify(['case-a'])],
      [JSON.stringify(['moved', 'cap/model', '', 0, 1]), JSON.stringify(['case-b'])],
    ]);
    const caseBChunk = storedChunks(sqlite).find(
      row => row.case_ids === JSON.stringify(['case-b'])
    );
    if (!caseBChunk) throw new Error('Expected the case-b chunk');
    // Spend the block's only attempt and fail it, exactly as an errored billed block ends.
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'failed', attempts = 1 WHERE id = ?")
      .run(caseBChunk.id);

    // The plan now names case-b first: its block would be chunk 0, an id that already belongs
    // to case-a, and case-a would take chunk 1. Neither may be re-created.
    await scheduleRunChunks(db, {
      runId: 'moved',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-b', 'case-a'],
      chunkSize: 1,
      laneCaseIds: new Map([
        [JSON.stringify([block.model, block.variant, 0]), ['case-b', 'case-a']],
      ]),
    });

    expect(
      storedChunks(sqlite).map(row => [row.id, row.case_ids, row.status, row.attempts])
    ).toEqual([
      [JSON.stringify(['moved', 'cap/model', '', 0, 0]), JSON.stringify(['case-a']), 'pending', 0],
      [JSON.stringify(['moved', 'cap/model', '', 0, 1]), JSON.stringify(['case-b']), 'failed', 1],
    ]);
    // The failed block is still not claimable: the carried counter is what the claim reads.
    expect(
      (await claimMany(db, schedulerConfig('{"slots":2}'), 2, 'after-move', NOW + 10)).map(
        claim => claim.case_ids
      )
    ).toEqual([JSON.stringify(['case-a'])]);
  });

  it("reads the run's rows once per plan version, not once per pass", async () => {
    // The case-level guard needs the run's rows, but reading them on every pass would make a
    // rescan cost O(rows written so far) per pass — quadratic over a large plan. The plan
    // fingerprint on the run gates it: an unchanged plan resumes from its prefix and reads
    // no rows at all, and only a re-plan pays one full read.
    insertRun(sqlite, 'cost', { purpose: 'user' });
    const block = { model: 'cap/model', variant: '' };
    const laneKey = JSON.stringify([block.model, block.variant, 0]);
    const caseIds = Array.from({ length: 40 }, (_, index) => `case-${index}`);
    const plan = new Map([[laneKey, caseIds]]);

    const reads = { chunkRows: 0, queries: 0 };
    const counting = sqliteD1(sqlite, () => {
      reads.queries += 1;
    });
    const counted = {
      ...counting,
      prepare(sqlText: string) {
        // The guard's pages, told apart from the lanes aggregate the resume cursor uses.
        if (sqlText.includes('SELECT id, model, variant, rep, case_ids FROM scheduler_chunks')) {
          reads.chunkRows += 1;
          // Every page carries the keyset bound (except the first) and the page size, so the
          // read can never become one unbounded result.
          expect(sqlText).toContain(`LIMIT ${SCHEDULER_MATERIALIZED_PAGE_SIZE}`);
          expect(sqlText).toContain('ORDER BY id');
        }
        return counting.prepare(sqlText);
      },
    } as unknown as D1Database;

    // First pass: no fingerprint recorded yet, so the plan is "changed" and it reads once.
    await scheduleRunChunks(counted, {
      runId: 'cost',
      entries: [block],
      repetitions: 1,
      caseIds,
      chunkSize: 1,
      laneCaseIds: plan,
    });
    expect(reads.chunkRows).toBe(1);
    // The plan's 40 single-case chunks are materialized and the plan version is recorded.
    expect(storedChunks(sqlite)).toHaveLength(40);
    expect(
      sqlite.prepare("SELECT plan_fingerprint FROM benchmark_runs WHERE id = 'cost'").get()
    ).toMatchObject({ plan_fingerprint: expect.any(String) });

    // Resume passes with the same plan: the prefix cursor carries them and no rows are read,
    // whatever the run already holds. This is the property that keeps the total linear.
    const before = reads.chunkRows;
    for (let pass = 0; pass < 5; pass++) {
      sqlite.prepare("DELETE FROM scheduler_runs WHERE run_id = 'cost'").run();
      await scheduleRunChunks(counted, {
        runId: 'cost',
        entries: [block],
        repetitions: 1,
        caseIds,
        chunkSize: 1,
        laneCaseIds: plan,
      });
    }
    expect(reads.chunkRows).toBe(before);

    // A re-plan reads the run's rows exactly once, however many rows it already holds.
    sqlite.prepare("DELETE FROM scheduler_runs WHERE run_id = 'cost'").run();
    await scheduleRunChunks(counted, {
      runId: 'cost',
      entries: [block],
      repetitions: 1,
      caseIds,
      chunkSize: 1,
      laneCaseIds: new Map([[laneKey, [...caseIds, 'case-new']]]),
    });
    // A re-plan reads the run's rows in keyset pages of SCHEDULER_MATERIALIZED_PAGE_SIZE:
    // 41 rows fit one page, so the statement count is the ceiling of rows/page, never one
    // unbounded result.
    expect(reads.chunkRows).toBe(before + Math.ceil(41 / SCHEDULER_MATERIALIZED_PAGE_SIZE));
    // Only the case the new plan adds is written; the 40 it already had keep their rows.
    expect(storedChunks(sqlite)).toHaveLength(41);
  });

  it('keeps each case’s cap when a re-plan regroups cases into different chunks', async () => {
    // Production chunks hold one case (`DECIDER_CHUNK_SIZE = 1`, src/run.ts:298), but the
    // initializer takes a chunk size, so the guard must be case-level rather than
    // case-set-level: a re-plan that regroups a multi-case chunk would otherwise hand every
    // case in it a fresh counter. Blocks are `(run, model, variant, rep, case)`.
    insertRun(sqlite, 'regrouped', { purpose: 'user' });
    const block = { model: 'cap/model', variant: 'low' };
    const laneKey = JSON.stringify([block.model, block.variant, 0]);
    await scheduleRunChunks(db, {
      runId: 'regrouped',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 2,
      laneCaseIds: new Map([[laneKey, ['case-a', 'case-b', 'case-c']]]),
    });
    // Two chunks: [a,b] and [c]. Fail the [c] chunk after spending its attempt.
    const chunkC = storedChunks(sqlite).find(row => row.case_ids === JSON.stringify(['case-c']));
    if (!chunkC) throw new Error('Expected the case-c chunk');
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'failed', attempts = 1 WHERE id = ?")
      .run(chunkC.id);
    expect(storedChunks(sqlite)).toHaveLength(2);
    // A re-plan can only reach the initializer while its pass is unfinished: the marker
    // commits with the last batch, and every later call returns immediately. Clearing it
    // models the interrupted pass a re-plan resumes from.
    const interruptInitialization = () =>
      sqlite.prepare("DELETE FROM scheduler_runs WHERE run_id = 'regrouped'").run();
    interruptInitialization();

    // The plan now regroups: [b,c] and [a]. case-b was in [a,b] and case-c was failed on its
    // own, so both new groupings contain a scheduled case and neither may be written. Only a
    // case with no row at all would be.
    await scheduleRunChunks(db, {
      runId: 'regrouped',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-b', 'case-c', 'case-a'],
      chunkSize: 2,
      laneCaseIds: new Map([[laneKey, ['case-b', 'case-c', 'case-a']]]),
    });

    // Nothing was re-created and no case inherited a second row: the [a,b] chunk still holds
    // only case-a and case-b, and case-c keeps its failed row and its spent attempt.
    expect(storedChunks(sqlite).map(row => [row.case_ids, row.status, row.attempts])).toEqual([
      [JSON.stringify(['case-a', 'case-b']), 'pending', 0],
      [JSON.stringify(['case-c']), 'failed', 1],
    ]);
    // A regrouped case never becomes claimable again: case-c has no second row to claim.
    // (Claims are checked once at the end, so no chunk is already live when they run.)

    // The plan now puts a NEW case beside an existing one: [a,b] stays, and [c,case-d] adds
    // case-d. Filtering the whole chunk on its existing case would silently drop case-d and
    // it would never be benchmarked, so only case-d may be written — at an id no row holds,
    // because the plan's own index 1 already belongs to the failed [case-c] chunk.
    interruptInitialization();
    await scheduleRunChunks(db, {
      runId: 'regrouped',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c', 'case-d'],
      chunkSize: 2,
      laneCaseIds: new Map([[laneKey, ['case-a', 'case-b', 'case-c', 'case-d']]]),
    });

    const after = storedChunks(sqlite).map(row => [row.case_ids, row.status, row.attempts]);
    // case-d gets exactly one row, holding only itself; case-c keeps its failed row and the
    // attempt it spent, and case-a/case-b keep their untouched pending row.
    expect(after).toEqual([
      [JSON.stringify(['case-a', 'case-b']), 'pending', 0],
      [JSON.stringify(['case-c']), 'failed', 1],
      [JSON.stringify(['case-d']), 'pending', 0],
    ]);
    const claimable = (
      await claimMany(db, schedulerConfig('{"slots":4}'), 4, 'after-new-case', NOW + 20)
    ).map(claim => claim.case_ids);
    // Both live cases are claimable exactly once, and the spent case is not: the cap still
    // follows the case, not the position.
    expect(claimable.sort()).toEqual([
      JSON.stringify(['case-a', 'case-b']),
      JSON.stringify(['case-d']),
    ]);
  });

  it('keeps the cap when an interrupted re-plan pass resumes, and never double-schedules a case', async () => {
    // kilobot's shape: an interrupted pass leaves the plan fingerprint unrecorded, so the
    // resumed pass must read the run's rows again. Without that it would resume as "unchanged"
    // and could place a residual chunk on a free id holding a case that already has a row.
    insertRun(sqlite, 'interrupted', { purpose: 'user' });
    const block = { model: 'cap/model', variant: '' };
    const laneKey = JSON.stringify([block.model, block.variant, 0]);
    await scheduleRunChunks(db, {
      runId: 'interrupted',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-a', 'case-b', 'case-c'],
      chunkSize: 1,
      laneCaseIds: new Map([[laneKey, ['case-a', 'case-b', 'case-c']]]),
    });
    // The pass that would have recorded the fingerprint was interrupted: no marker, and no
    // fingerprint on the run either.
    sqlite.prepare("DELETE FROM scheduler_runs WHERE run_id = 'interrupted'").run();
    sqlite
      .prepare("UPDATE benchmark_runs SET plan_fingerprint = NULL WHERE id = 'interrupted'")
      .run();
    // The re-plan prepends a new case, so every existing one moves one position: [d,a,b,c].
    await scheduleRunChunks(db, {
      runId: 'interrupted',
      entries: [block],
      repetitions: 1,
      caseIds: ['case-d', 'case-a', 'case-b', 'case-c'],
      chunkSize: 1,
      laneCaseIds: new Map([[laneKey, ['case-d', 'case-a', 'case-b', 'case-c']]]),
    });

    // Every case has exactly one row: the new case-d is scheduled, and no existing case was
    // written twice while its position moved.
    const rows = storedChunks(sqlite).map(row => JSON.parse(row.case_ids) as string[]);
    const scheduled = rows.flat();
    expect(scheduled.sort()).toEqual(['case-a', 'case-b', 'case-c', 'case-d']);
    // Exactly one row per case: the check above would still pass if one case held two rows
    // and another none, so count them.
    expect(new Set(scheduled).size).toBe(scheduled.length);
    expect(rows.every(cases => cases.length === 1)).toBe(true);
  });

  it('hashes every repetition, so a plan that fills a reused lane still reads as changed', async () => {
    // Repetition 0 is fully reused (no planned rows) while repetition 1 is planned. If the
    // fingerprint skipped the empty lane and returned early, a changed plan for repetition 1
    // would hash equal: the pass would take the prefix path with no materialized set, and a
    // case that moved above the prefix would be dropped by ON CONFLICT DO NOTHING.
    insertRun(sqlite, 'reused-rep', { purpose: 'user' });
    const block = { model: 'cap/model', variant: '' };
    const laneKey = (rep: number) => JSON.stringify([block.model, block.variant, rep]);
    const firstPlan = new Map([
      [laneKey(0), []],
      [laneKey(1), ['case-a', 'case-b']],
    ]);
    await scheduleRunChunks(db, {
      runId: 'reused-rep',
      entries: [block],
      repetitions: 2,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
      laneCaseIds: firstPlan,
    });
    expect(storedChunks(sqlite).map(row => row.case_ids)).toEqual([
      JSON.stringify(['case-a']),
      JSON.stringify(['case-b']),
    ]);
    const recorded = sqlite
      .prepare("SELECT plan_fingerprint FROM benchmark_runs WHERE id = 'reused-rep'")
      .get() as { plan_fingerprint: string };
    expect(recorded.plan_fingerprint).toEqual(expect.any(String));

    // Re-plan repetition 1 by moving case-b ahead of case-a. Repetition 0 stays empty.
    sqlite.prepare("DELETE FROM scheduler_runs WHERE run_id = 'reused-rep'").run();
    await scheduleRunChunks(db, {
      runId: 'reused-rep',
      entries: [block],
      repetitions: 2,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
      laneCaseIds: new Map([
        [laneKey(0), []],
        [laneKey(1), ['case-b', 'case-a']],
      ]),
    });

    // The fingerprint changed, so the guard ran: each case still has exactly one row.
    expect(
      (
        sqlite
          .prepare("SELECT plan_fingerprint FROM benchmark_runs WHERE id = 'reused-rep'")
          .get() as { plan_fingerprint: string }
      ).plan_fingerprint
    ).not.toBe(recorded.plan_fingerprint);
    const scheduled = storedChunks(sqlite).flatMap(row => JSON.parse(row.case_ids) as string[]);
    expect(scheduled.sort()).toEqual(['case-a', 'case-b']);
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });

  it('keeps the same chunk id when a larger chunk size changes nothing for one case', async () => {
    insertRun(sqlite, 'resize');
    const id = await exhaustOneBlock('resize', 'case-a');
    // chunkSize is a constant 1 for every decider run, but even a different size lands the
    // only case at chunk 0; the id must not move and the counter must not restart.
    await scheduleRunChunks(db, {
      runId: 'resize',
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 3,
    });
    expect(storedChunks(sqlite).find(row => row.id === id)).toMatchObject({
      status: 'failed',
      attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS,
    });
    expect(
      await claimMany(db, schedulerConfig('{"slots":1}'), 2, 'resize-after', NOW + 10)
    ).toEqual([]);
  });

  it('assigns every block the same chunk id and counter on every replay', async () => {
    insertRun(sqlite, 'narrowed');
    // `laneCaseIds` can shift case offsets, but the initializer builds it only for a user run
    // (`if (run.purpose === 'user')`, src/run.ts:1658); a platform run always measures the
    // whole ordered catalog list, so each block keeps its own chunk index across replays.
    const caseIds = ['case-a', 'case-b', 'case-c'];
    await scheduleRunChunks(db, {
      runId: 'narrowed',
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds,
      chunkSize: 1,
    });
    const before = storedChunks(sqlite).map(row => [row.id, row.case_ids]);
    expect(before).toEqual(
      caseIds.map((caseId, index) => [
        JSON.stringify(['narrowed', 'cap/model', 'high', 0, index]),
        JSON.stringify([caseId]),
      ])
    );
    // Replaying the same initialization, which is what every retry path does, is a no-op.
    await scheduleRunChunks(db, {
      runId: 'narrowed',
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds,
      chunkSize: 1,
    });
    expect(storedChunks(sqlite).map(row => [row.id, row.case_ids])).toEqual(before);
  });

  it('prunes a failed chunk only with its stale run, and a terminal run is never re-opened', async () => {
    insertRun(sqlite, 'pruned');
    const id = await exhaustOneBlock('pruned', 'case-a');

    // A running run's failed chunk is retained through the whole 24-hour window.
    await recoverChunks(db, NOW + 23 * 3600_000);
    expect(storedChunks(sqlite).find(row => row.id === id)).toMatchObject({
      status: 'failed',
      attempts: SCHEDULER_MAX_PLATFORM_ATTEMPTS,
    });

    // Only a run that already left `running` is pruned, and nothing in production writes a
    // run back to `running` (no UPDATE benchmark_runs ... 'running' exists; a requeue starts
    // a brand-new run id). So there is no later initialization that could recreate the row.
    // The initialization marker the schedule pass already wrote names it for the prune,
    // exactly as a real completed run's does.
    sqlite
      .prepare("UPDATE benchmark_runs SET status = 'failed', completed_at = ? WHERE id = 'pruned'")
      .run(new Date(NOW).toISOString());
    await recoverChunks(db, NOW + 25 * 3600_000);
    expect(storedChunks(sqlite).find(row => row.id === id)).toBeUndefined();
    await scheduleRunChunks(db, {
      runId: 'pruned',
      entries: [{ model: 'cap/model', variant: 'high' }],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 1,
    });
    // A terminal run's initialization is refused, so the pruned block is never recreated.
    expect(storedChunks(sqlite)).toEqual([]);
  });
});
