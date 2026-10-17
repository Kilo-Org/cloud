import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  beginPaidCase,
  claimScheduledChunks,
  clearUnbilledCase,
  cooldownProviders,
  deferChunk,
  finishChunk,
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
  SCHEDULER_MAX_ATTEMPTS,
  SCHEDULER_QUEUE_LEASE_MS,
  SCHEDULER_UNSETTLED_SQL,
} from './scheduler';
import type { SchedulerClaim, SchedulerConfig } from './scheduler';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');

type TestEntry = { model: string; variant: string | null; providers: string[] };
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
};

function insertRun(sqlite: DatabaseSync, id: string, options: RunOptions = {}) {
  sqlite
    .prepare(`
    INSERT INTO benchmark_runs (
      id, router, kind, purpose, status, started_at,
      min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity
    ) VALUES (?, ?, ?, ?, 'running', ?, 0.7, 3, 4, 1, 'scheduler-storage-test')
  `)
    .run(
      id,
      options.router ?? 'efficient',
      options.kind ?? 'decider',
      options.purpose ?? 'platform',
      new Date(NOW).toISOString()
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
    providers: ['deepinfra'],
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
      providerConcurrency: 16,
      unknownProviderConcurrency: 2,
      modelLimits: {},
      providerLimits: {},
      shares: { 'efficient/platform': 2, 'frontier/platform': 2, 'efficient/user': 1 },
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
        {
          model: 'shared/model',
          variant: null,
          providers: ['provider-b', 'provider-a', 'provider-a'],
        },
        { model: 'shared/model', variant: 'high', providers: [] },
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
    expect(rows.filter(row => row.variant === '').map(row => row.providers)).toEqual(
      Array(4).fill('["provider-a","provider-b"]')
    );
    await scheduleRunChunks(db, { ...input, caseIds: ['different-case'] });
    expect(storedChunks(sqlite)).toEqual(rows);
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
    const claims = await claimMany(
      db,
      schedulerConfig('{"providerConcurrency":250}'),
      280,
      'ceiling'
    );
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
      entries: [{ model: 'deep/model', variant: '', providers: ['deepinfra'] }],
      repetitions: 1,
      caseIds: Array.from({ length: 12 }, (_, index) => `case-${index}`),
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":8,"modelConcurrency":8,"providerConcurrency":8}');
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

    // Every model of the fixture shares one provider, so the default provider cap
    // is already saturated: the pass must conclude that without walking the backlog.
    const saturated = performance.now();
    expect(await claimScheduledChunks(db, schedulerConfig(), NOW, 'scale-saturated')).toEqual([]);
    expect(performance.now() - saturated).toBeLessThan(3_000);

    const started = performance.now();
    const claims = await claimScheduledChunks(
      db,
      schedulerConfig('{"providerConcurrency":250}'),
      NOW,
      'scale'
    );
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
      schedulerConfig('{"providerConcurrency":250,"modelConcurrency":250}'),
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
    const config = schedulerConfig('{"slots":10,"modelConcurrency":10,"providerConcurrency":10}');
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

  it('applies the default provider cap and conservative unknown cap across unrelated models', async () => {
    insertRun(sqlite, 'default-providers');
    await scheduleRunChunks(db, {
      runId: 'default-providers',
      entries: [
        ...independentEntries(20),
        ...Array.from({ length: 4 }, (_, index) => ({
          model: `different-namespace-${index}/unknown`,
          variant: '',
          providers: [],
        })),
      ],
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":24}');
    const claims = await claimMany(db, config, 40, 'default-providers');
    expect(claims).toHaveLength(18);
    const live = liveChunks(sqlite);
    expect(live.filter(row => row.providers === '["deepinfra"]')).toHaveLength(16);
    expect(live.filter(row => row.providers === '[]')).toHaveLength(2);
    expect(storedChunks(sqlite).filter(row => row.status === 'pending')).toHaveLength(6);
  });

  it('counts each inference provider intersection and the unknown pool independently of model prefixes', async () => {
    insertRun(sqlite, 'providers');
    await scheduleRunChunks(db, {
      runId: 'providers',
      entries: [
        { model: 'a/dual', variant: '', providers: ['deepinfra', 'fireworks'] },
        { model: 'b/only-a', variant: '', providers: ['deepinfra'] },
        { model: 'c/only-b', variant: '', providers: ['fireworks'] },
        { model: 'a/independent', variant: '', providers: ['together'] },
        { model: 'unknown/first', variant: '', providers: [] },
        { model: 'unknown/second', variant: '', providers: [] },
      ],
      repetitions: 1,
      caseIds: ['case'],
      chunkSize: 1,
    });
    const config = schedulerConfig(
      JSON.stringify({
        slots: 6,
        providerConcurrency: 2,
        unknownProviderConcurrency: 1,
        providerLimits: { deepinfra: 1, fireworks: 1 },
      })
    );
    const claims = await claimMany(db, config, 12, 'providers');
    expect(claims).toHaveLength(3);
    expect(claims.map(claim => claim.model)).toEqual(
      expect.arrayContaining(['a/dual', 'a/independent'])
    );
    expect(claims.filter(claim => JSON.parse(claim.providers).length === 0)).toHaveLength(1);
    expect(
      storedChunks(sqlite)
        .filter(row => row.status === 'pending')
        .map(row => row.model)
    ).toEqual(expect.arrayContaining(['b/only-a', 'c/only-b']));
    const dual = claims.find(claim => claim.model === 'a/dual');
    if (!dual) throw new Error('Expected the intersecting provider claim');
    expect(await startChunk(db, dual.id, dual.token, NOW)).toBe(true);
    await finishChunk(db, dual.id, dual.token);
    const replacements = await claimMany(db, config, 12, 'provider-release');
    expect(replacements.map(claim => claim.model).sort()).toEqual(['b/only-a', 'c/only-b']);
    const persisted = liveChunks(sqlite);
    for (const provider of ['deepinfra', 'fireworks', 'together']) {
      expect(
        persisted.filter(row => JSON.parse(row.providers).includes(provider)).length
      ).toBeLessThanOrEqual(config.providerLimits[provider] ?? config.providerConcurrency);
    }
    expect(persisted.filter(row => JSON.parse(row.providers).length === 0)).toHaveLength(1);
  });

  it('shares a model cap across variants and separate runs while other models remain runnable', async () => {
    insertRun(sqlite, 'classifier', { kind: 'classifier' });
    insertRun(sqlite, 'decider');
    for (const runId of ['classifier', 'decider']) {
      await scheduleRunChunks(db, {
        runId,
        entries: [
          { model: 'same/model', variant: 'low', providers: ['provider'] },
          { model: 'same/model', variant: 'high', providers: ['provider'] },
          { model: 'other/model', variant: '', providers: ['provider'] },
        ],
        repetitions: 1,
        caseIds: ['case-a', 'case-b'],
        chunkSize: 1,
      });
    }
    const config = schedulerConfig(
      JSON.stringify({
        slots: 8,
        providerConcurrency: 8,
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
      entries: [{ model: 'lane/model', variant: '', providers: ['deepinfra'] }],
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

  it('fails exhausted leases without allowing another claim or retaining a slot', async () => {
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
    for (let attempt = 1; attempt <= SCHEDULER_MAX_ATTEMPTS; attempt++) {
      const [claim] = await claimMany(db, config, 1, `attempt-${attempt}`, now);
      if (!claim) throw new Error(`Expected claim attempt ${attempt}`);
      expect(claim.attempts).toBe(attempt);
      now += SCHEDULER_QUEUE_LEASE_MS;
      const failed = await recoverChunks(db, now);
      expect(failed).toHaveLength(attempt === SCHEDULER_MAX_ATTEMPTS ? 1 : 0);
    }
    expect(storedChunks(sqlite)[0]).toMatchObject({
      status: 'failed',
      slot: null,
      token: null,
      lease_until: 0,
      attempts: SCHEDULER_MAX_ATTEMPTS,
    });
    expect(await claimMany(db, config, 4, 'after-exhaustion', now)).toEqual([]);
    expect(liveChunks(sqlite)).toEqual([]);
  });

  it('persists the paid-case guard across connection restart, lease recovery and token replacement', async () => {
    insertRun(sqlite, 'paid');
    await scheduleRunChunks(db, {
      runId: 'paid',
      entries: [{ model: 'paid/model', variant: 'low', providers: ['provider'] }],
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
    await restartPaidCase(db, { ...key, token: 'another-token' }, NOW + 1_000);
    expect(await getPaidCaseStartedAt(db, key)).toBe(NOW);
    await restartPaidCase(db, key, NOW + 2_000);
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
        { model: 'same/model', variant: 'low', providers: ['provider'] },
        { model: 'same/model', variant: 'high', providers: ['provider'] },
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
      entries: [{ model: 'slow/model', variant: 'high', providers: ['slow-provider'] }],
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
          { model: 'a/held', variant: '', providers: ['deepinfra'] },
          { model: 'b/queued', variant: '', providers: ['fireworks'] },
        ],
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const config = schedulerConfig('{"slots":3,"modelConcurrency":1,"providerConcurrency":1}');
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
          { model: 'a/held', variant: 'high', providers: ['together'] },
          { model: 'c/shared-provider', variant: '', providers: ['deepinfra'] },
          { model: 'd/released-provider', variant: '', providers: ['fireworks'] },
          { model: 'e/independent', variant: '', providers: ['together'] },
        ],
        repetitions: 1,
        caseIds: ['case'],
        chunkSize: 1,
      });
      const successors = await claimMany(db, config, 10, 'successor', NOW + 1);
      expect(successors.map(claim => claim.model).sort()).toEqual([
        'd/released-provider',
        'e/independent',
      ]);
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
      expect(reused).toMatchObject({ model: 'c/shared-provider', slot: active.slot });
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
        { model: 'shared/model', variant: 'low', providers: ['deepinfra'] },
        { model: 'shared/model', variant: 'high', providers: ['deepinfra'] },
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
      schedulerConfig('{"slots":20,"modelConcurrency":20,"providerConcurrency":20}'),
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
    expect(insertPlan).not.toContain('scheduler_chunks');
    const lanesPlan = explainPlan(sqlite, SCHEDULER_MATERIALIZED_LANES_SQL);
    expect(lanesPlan).toContain(
      'SEARCH scheduler_chunks USING INDEX IX_scheduler_chunks_run (run_id=?)'
    );
    expect(lanesPlan).not.toContain('SCAN scheduler_chunks');
  });

  it('does not repeatedly report failed chunks from lanes already recorded in run_lane_failures', async () => {
    insertRun(sqlite, 'failed-lanes');
    await scheduleRunChunks(db, {
      runId: 'failed-lanes',
      entries: [
        { model: 'shared/model', variant: 'low', providers: ['deepinfra'] },
        { model: 'shared/model', variant: 'high', providers: ['deepinfra'] },
      ],
      repetitions: 2,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    sqlite
      .prepare("UPDATE scheduler_chunks SET status = 'failed', attempts = ?")
      .run(SCHEDULER_MAX_ATTEMPTS);
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

  it('cools every possible inference provider and the whole model across runs without delaying unrelated work', async () => {
    insertRun(sqlite, 'a-cooldown');
    await scheduleRunChunks(db, {
      runId: 'a-cooldown',
      entries: [
        { model: 'a/throttled', variant: 'high', providers: ['deepinfra', 'fireworks'] },
        { model: 'a/throttled', variant: 'low', providers: ['together'] },
        { model: 'b/one-provider', variant: '', providers: ['deepinfra'] },
        { model: 'c/second-provider', variant: '', providers: ['fireworks'] },
        { model: 'd/fallback', variant: '', providers: ['google-vertex', 'fireworks'] },
        { model: 'e/unrelated', variant: '', providers: ['together'] },
        { model: 'f/unknown', variant: '', providers: [] },
      ],
      repetitions: 1,
      caseIds: ['case-a', 'case-b'],
      chunkSize: 1,
    });
    const config = schedulerConfig('{"slots":1}');
    const [throttled] = await claimMany(db, config, 1, 'throttled');
    if (!throttled) throw new Error('Expected the throttled multi-provider chunk');
    expect(throttled).toMatchObject({ model: 'a/throttled', variant: 'high' });
    expect(JSON.parse(throttled.providers)).toEqual(['deepinfra', 'fireworks']);
    insertRun(sqlite, 'z-other-run', { router: 'frontier' });
    await scheduleRunChunks(db, {
      runId: 'z-other-run',
      entries: [
        { model: 'a/throttled', variant: 'high', providers: ['together'] },
        { model: 'z/remote-fireworks', variant: '', providers: ['fireworks'] },
      ],
      repetitions: 1,
      caseIds: ['case-a'],
      chunkSize: 1,
    });
    const until = NOW + 1000;
    await cooldownProviders(db, throttled, until);
    expect(
      sqlite.prepare('SELECT scope, key, until FROM scheduler_cooldowns ORDER BY scope, key').all()
    ).toEqual([
      { scope: 'model', key: 'a/throttled', until },
      { scope: 'provider', key: 'deepinfra', until },
      { scope: 'provider', key: 'fireworks', until },
    ]);
    // The throttled chunk keeps its own schedule: cooling is a dispatch filter, not
    // a rewrite of every pending row that shares the model or a provider.
    expect(storedChunks(sqlite).every(row => row.available_at === 0)).toBe(true);
    await cooldownProviders(db, throttled, NOW + 500);
    expect(
      sqlite.prepare('SELECT scope, key, until FROM scheduler_cooldowns ORDER BY scope, key').all()
    ).toEqual([
      { scope: 'model', key: 'a/throttled', until },
      { scope: 'provider', key: 'deepinfra', until },
      { scope: 'provider', key: 'fireworks', until },
    ]);
    expect(await startChunk(db, throttled.id, throttled.token, NOW)).toBe(true);
    await finishChunk(db, throttled.id, throttled.token);
    for (let index = 0; index < 4; index++) {
      const [unrelated] = await claimMany(db, config, 1, `unrelated-${index}`);
      if (!unrelated) throw new Error('Expected unthrottled work to remain runnable');
      expect(['e/unrelated', 'f/unknown']).toContain(unrelated.model);
      expect(await startChunk(db, unrelated.id, unrelated.token, NOW)).toBe(true);
      await finishChunk(db, unrelated.id, unrelated.token);
    }
    expect(liveChunks(sqlite)).toEqual([]);
    expect(await claimMany(db, config, 3, 'cooldown-wait', until - 1)).toEqual([]);
    const available = await claimMany(db, config, 1, 'cooldown-elapsed', until);
    expect(available).toHaveLength(1);
    const cooledModels = [
      'a/throttled',
      'b/one-provider',
      'c/second-provider',
      'd/fallback',
      'z/remote-fireworks',
    ];
    expect(available.every(claim => cooledModels.includes(claim.model))).toBe(true);
    expect(await recoverChunks(db, until)).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM scheduler_cooldowns').all()).toEqual([]);
  });

  it('clears only the exact unbilled admission token and cannot erase its replacement admission', async () => {
    insertRun(sqlite, 'unbilled');
    await scheduleRunChunks(db, {
      runId: 'unbilled',
      entries: [{ model: 'paid/model', variant: 'low', providers: ['deepinfra'] }],
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
        { model: 'dead/model', variant: '', providers: ['deepinfra'] },
        { model: 'live/model', variant: '', providers: ['fireworks'] },
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
  });
});
