import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALIAS_READINESS_LEASE_ID,
  acquireAliasPromotionLease,
  releaseAliasPromotionLease,
  type AliasPromotionProfileIdentity,
} from './alias-promotion';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { computeEngineIdentity } from './run';
import { app } from './index';

const EFFICIENT_ENGINE = computeEngineIdentity('decider', 'efficient');
const FRONTIER_ENGINE = computeEngineIdentity('decider', 'frontier');

/** The live identity pair the route resolves for each base router. */
const LIVE_IDENTITIES: AliasPromotionProfileIdentity[] = [
  { router: 'efficient', engine_identity: EFFICIENT_ENGINE, repetitions: 3 },
  { router: 'frontier', engine_identity: FRONTIER_ENGINE, repetitions: 1 },
];
const acquire = (token: string, models: readonly string[] = []) =>
  acquireAliasPromotionLease(db, token, models, LIVE_IDENTITIES);

let sqlite: DatabaseSync;
let db: D1Database;

type ProfileSeed = {
  router?: 'efficient' | 'frontier';
  model: string;
  variant?: string;
  engine?: string;
  repetitions?: number;
  status?: string;
  runId?: string | null;
};

function insertProfile(seed: ProfileSeed) {
  sqlite
    .prepare(
      `INSERT INTO benchmark_profiles
        (router, model, variant, engine_identity, repetitions, status, run_id,
          requested_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-01', '2026-11-01', '2026-11-02')`
    )
    .run(
      seed.router ?? 'efficient',
      seed.model,
      seed.variant ?? '',
      seed.engine ?? EFFICIENT_ENGINE,
      seed.repetitions ?? 3,
      seed.status ?? 'ready',
      seed.runId === undefined ? `run-${seed.model}` : seed.runId
    );
}

function lockRows() {
  return sqlite
    .prepare('SELECT id, token, lease_until FROM scheduler_dispatch_lock ORDER BY id')
    .all()
    .map(row => ({ ...row }));
}

function rowSnapshot() {
  return {
    profiles: sqlite
      .prepare('SELECT * FROM benchmark_profiles ORDER BY router, model, variant')
      .all(),
    cases: sqlite.prepare('SELECT * FROM case_results ORDER BY run_id, model, case_id').all(),
    chunks: sqlite.prepare('SELECT * FROM scheduler_chunks ORDER BY id').all(),
    runs: sqlite.prepare('SELECT * FROM benchmark_runs ORDER BY id').all(),
  };
}

function seedUnrelatedWork() {
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs
        (id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
          max_concurrency, repetitions, engine_identity)
       VALUES ('run-vendor', 'efficient', 'decider', 'platform', 'running', '2026-11-01',
         0.7, 3, 4, 3, ?)`
    )
    .run(EFFICIENT_ENGINE);
  sqlite
    .prepare(
      `INSERT INTO case_results
        (run_id, model, variant, case_id, score, latency_ms, rep)
       VALUES ('run-vendor', 'vendor/measured', '', 'case-1', 0.9, 120, 0)`
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO scheduler_chunks
        (id, run_id, model, variant, providers, rep, chunk, case_ids, status)
       VALUES ('chunk-1', 'run-vendor', 'vendor/measured', '', '[]', 0, 0, '["case-1"]',
         'pending')`
    )
    .run();
}

function leaseRow() {
  return sqlite
    .prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = ?')
    .get(ALIAS_READINESS_LEASE_ID) as { token: string | null; lease_until: number } | undefined;
}

function expireLease() {
  sqlite
    .prepare('UPDATE scheduler_dispatch_lock SET lease_until = 1 WHERE id = ?')
    .run(ALIAS_READINESS_LEASE_ID);
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  db = sqliteD1(sqlite);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('alias promotion readiness lease (real migrations)', () => {
  it('owns row 4 and leaves rows 1-3 to dispatch, initialization and deploy', async () => {
    const farFuture = 9_999_999_999_999;
    expect(ALIAS_READINESS_LEASE_ID).toBe(4);
    sqlite
      .prepare('UPDATE scheduler_dispatch_lock SET token = ?, lease_until = ? WHERE id = 1')
      .run('dispatch', farFuture);
    sqlite
      .prepare('INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (2, ?, ?)')
      .run('init', farFuture);
    sqlite
      .prepare('INSERT INTO scheduler_dispatch_lock (id, token, lease_until) VALUES (3, ?, ?)')
      .run('deploy-intent-x', farFuture);
    const before = lockRows();

    expect((await acquire('token-a', [])).status).toBe('held');
    await releaseAliasPromotionLease(db, 'token-a');

    expect(lockRows()).toEqual([...before, { id: 4, token: null, lease_until: 0 }]);
  });

  it('answers busy to a competing token and holds the winner until it releases', async () => {
    const first = await acquire('token-a', []);
    expect(first.status).toBe('held');
    if (first.status !== 'held') return;
    expect(first.leaseUntil).toBeGreaterThan(Date.now());

    expect(await acquire('token-b', [])).toEqual({ status: 'busy' });
    expect(leaseRow()).toEqual({ token: 'token-a', lease_until: first.leaseUntil });

    await releaseAliasPromotionLease(db, 'token-a');
    expect(await acquire('token-b', [])).toMatchObject({
      status: 'held',
    });
  });

  it('never releases another token and frees the exact token', async () => {
    const held = await acquire('token-a', []);
    if (held.status !== 'held') throw new Error('expected the fence');

    await releaseAliasPromotionLease(db, 'token-b');
    expect(leaseRow()).toEqual({ token: 'token-a', lease_until: held.leaseUntil });

    await releaseAliasPromotionLease(db, 'token-a');
    expect(leaseRow()).toEqual({ token: null, lease_until: 0 });
  });

  it('retries the same token without renewing it', async () => {
    const held = await acquire('token-a', []);
    if (held.status !== 'held') throw new Error('expected the fence');

    expect(await acquire('token-a', [])).toEqual(held);
    expect(leaseRow()).toEqual({ token: 'token-a', lease_until: held.leaseUntil });
  });

  it('refuses an expired same-token attempt and requires a fresh token', async () => {
    const held = await acquire('token-a', []);
    if (held.status !== 'held') throw new Error('expected the fence');

    expireLease();
    expect(await acquire('token-a', [])).toEqual({ status: 'busy' });
    expect(leaseRow()).toEqual({ token: 'token-a', lease_until: 1 });

    const fresh = await acquire('token-b', []);
    expect(fresh.status).toBe('held');
    expect(leaseRow()).toEqual({
      token: 'token-b',
      lease_until: fresh.status === 'held' ? fresh.leaseUntil : null,
    });
  });

  it('holds independently of a live operator lock on row 1', async () => {
    const farFuture = 9_999_999_999_999;
    sqlite
      .prepare('UPDATE scheduler_dispatch_lock SET token = ?, lease_until = ? WHERE id = 1')
      .run('operator-pause-userpay', farFuture);

    const held = await acquire('token-a', []);
    expect(held.status).toBe('held');
    await releaseAliasPromotionLease(db, 'token-a');

    expect(
      sqlite.prepare('SELECT token, lease_until FROM scheduler_dispatch_lock WHERE id = 1').get()
    ).toEqual({ token: 'operator-pause-userpay', lease_until: farFuture });
  });

  it('reports only ready current-engine pairs of the asked ids and reads no catalog', async () => {
    insertProfile({ model: 'vendor/measured' });
    insertProfile({ model: 'vendor/retired' });
    insertProfile({ model: 'vendor/wrong-engine', engine: 'efficient:v0:stale' });
    insertProfile({ model: 'vendor/wrong-reps', repetitions: 1 });
    insertProfile({ model: 'vendor/failed', status: 'failed', runId: 'run-failed' });
    insertProfile({ model: 'vendor/no-run', status: 'ready', runId: null });
    insertProfile({ model: 'vendor/unasked' });
    insertProfile({
      model: 'vendor/frontier-only',
      router: 'frontier',
      engine: FRONTIER_ENGINE,
      repetitions: 1,
    });
    insertProfile({
      model: 'vendor/frontier-wrong-reps',
      router: 'frontier',
      engine: FRONTIER_ENGINE,
      repetitions: 3,
    });

    const catalogFetch = vi.fn(() => {
      throw new Error('the readiness fence must not read the catalog');
    });
    vi.stubGlobal('fetch', catalogFetch);

    const acquired = await acquire('token-a', [
      'vendor/measured',
      'vendor/retired',
      'vendor/wrong-engine',
      'vendor/wrong-reps',
      'vendor/failed',
      'vendor/no-run',
      'vendor/frontier-only',
      'vendor/frontier-wrong-reps',
      'vendor/not-asked-elsewhere',
    ]);

    expect(catalogFetch).not.toHaveBeenCalled();
    expect(acquired).toMatchObject({
      status: 'held',
      ready: [
        { router: 'efficient', model: 'vendor/measured' },
        { router: 'efficient', model: 'vendor/retired' },
        { router: 'frontier', model: 'vendor/frontier-only' },
      ],
    });
  });

  it('ignores ids nobody asked about and leaves profiles, cases, chunks and runs untouched', async () => {
    insertProfile({ model: 'vendor/measured' });
    insertProfile({ model: 'vendor/unasked' });
    seedUnrelatedWork();
    const before = rowSnapshot();

    const acquired = await acquire('token-a', ['vendor/measured']);
    expect(acquired).toMatchObject({
      status: 'held',
      ready: [{ router: 'efficient', model: 'vendor/measured' }],
    });
    await releaseAliasPromotionLease(db, 'token-a');

    expect(rowSnapshot()).toEqual(before);
  });

  it('does not hand out readiness while a competing fence is live', async () => {
    insertProfile({ model: 'vendor/measured' });
    await acquire('token-a', ['vendor/measured']);

    const busy = await acquire('token-b', ['vendor/measured']);
    expect(busy).toEqual({ status: 'busy' });
    expect(leaseRow()?.token).toBe('token-a');
  });
});

describe('POST /admin/alias-promotion (admin API)', () => {
  const env = () =>
    ({
      INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' },
      BENCH_DB: db,
    }) as unknown as Env;

  const post = (body: unknown, token = 'bench-token') =>
    app.request(
      'https://bench.example.com/admin/alias-promotion',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env()
    );

  it('requires the internal admin token', async () => {
    const response = await post(
      { action: 'acquire', token: crypto.randomUUID(), models: [] },
      'wrong'
    );
    expect(response.status).toBe(401);
  });

  it('rejects a body outside the discriminated request contract', async () => {
    expect((await post({ action: 'acquire', token: 'not-a-uuid', models: [] })).status).toBe(400);
    expect((await post({ action: 'release' })).status).toBe(400);
    expect(
      (
        await post({
          action: 'acquire',
          token: crypto.randomUUID(),
          models: Array.from({ length: 33 }, (_, index) => `vendor/model-${index}`),
        })
      ).status
    ).toBe(400);
  });

  it('acquires, reports readiness, answers busy, and releases the exact token', async () => {
    insertProfile({ model: 'vendor/measured' });
    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();

    const held = await post({ action: 'acquire', token: tokenA, models: ['vendor/measured'] });
    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({
      status: 'held',
      ready: [{ router: 'efficient', model: 'vendor/measured' }],
    });

    expect(await (await post({ action: 'acquire', token: tokenB, models: [] })).json()).toEqual({
      status: 'busy',
    });

    await post({ action: 'release', token: tokenB });
    expect(
      await (await post({ action: 'acquire', token: tokenB, models: [] })).json()
    ).toMatchObject({ status: 'busy' });

    expect(await (await post({ action: 'release', token: tokenA })).json()).toEqual({
      status: 'released',
    });
    expect(
      await (await post({ action: 'acquire', token: tokenB, models: [] })).json()
    ).toMatchObject({ status: 'held' });
  });
});
