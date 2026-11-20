import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
  type BenchmarkConfig,
} from '@kilocode/auto-routing-contracts';
import { BenchmarkModelCatalogSchema } from './platform-models';
import {
  continueDailyReconcile,
  dailyReconcileSubscriptions,
  loadSubscriptionSnapshot,
  mapSubscriptionStatuses,
  PLATFORM_SUBSCRIPTION_OWNER,
  servingSubscriptionSnapshot,
  snapshotPairs,
  syncSubscriptionSnapshot,
} from './subscriptions';

vi.mock('./run', () => ({ computeEngineIdentity: () => 'engine' }));
vi.mock('./config', () => ({ getBenchmarkConfig: vi.fn() }));
vi.mock('./executable-models', () => ({ fetchExecutableBenchmarkModelCatalog: vi.fn() }));
vi.mock('./db', () => ({
  exactPairKey: (model: string, variant: string | null) => `${model}:${variant ?? ''}`,
  listReadyCurrentProfilesForEntries: vi.fn(),
}));
import { getBenchmarkConfig } from './config';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import { listReadyCurrentProfilesForEntries } from './db';

const config = {
  router: 'efficient',
  minAccuracy: 0.7,
  accuracyNoiseBand: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  deciderModels: [],
} as unknown as BenchmarkConfig;
const owner = { ownerType: 'user' as const, ownerId: 'test-owner' };
const pool = [{ model: '~vendor/latest' }];
function catalog(target: string) {
  return BenchmarkModelCatalogSchema.parse({
    data: [{ id: '~vendor/latest', alias_target: target }, { id: target }],
  });
}
let sqlite: DatabaseSync;
let env: Env;
let afterOwnerEnumeration: (() => Promise<void>) | undefined;
let afterOwnerSnapshotWrite: (() => Promise<void>) | undefined;
let beforeOwnerSnapshotWrite: (() => Promise<void>) | undefined;
let afterOwnerRowRead: (() => Promise<void>) | undefined;
let failOwnerReads: Set<string>;
let writes: { sql: string; changes: number }[];
function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const bound = (params: unknown[]) => ({
        async first() {
          if (params.some(param => failOwnerReads.has(String(param))))
            throw new Error('D1 owner read failed');
          const row = db.prepare(sql).get(...(params as never[])) ?? null;
          if (
            sql.includes('snapshot FROM benchmark_subscriptions') &&
            params.includes(owner.ownerId) &&
            afterOwnerRowRead
          ) {
            const callback = afterOwnerRowRead;
            afterOwnerRowRead = undefined;
            await callback();
          }
          return row;
        },
        async all() {
          const results = db.prepare(sql).all(...(params as never[]));
          if (sql.includes("owner_type != 'platform'") && afterOwnerEnumeration) {
            const callback = afterOwnerEnumeration;
            afterOwnerEnumeration = undefined;
            await callback();
          }
          return { results };
        },
        async run() {
          if (
            sql.startsWith('UPDATE benchmark_subscriptions') &&
            params.includes(owner.ownerId) &&
            beforeOwnerSnapshotWrite
          ) {
            const callback = beforeOwnerSnapshotWrite;
            beforeOwnerSnapshotWrite = undefined;
            await callback();
          }
          const changes = Number(db.prepare(sql).run(...(params as never[])).changes);
          writes.push({ sql, changes });
          if (
            sql.startsWith('UPDATE benchmark_subscriptions') &&
            params.includes(owner.ownerId) &&
            afterOwnerSnapshotWrite
          ) {
            const callback = afterOwnerSnapshotWrite;
            afterOwnerSnapshotWrite = undefined;
            await callback();
          }
          return { meta: { changes } };
        },
        bind(...values: unknown[]) {
          return bound(values);
        },
      });
      return bound([]);
    },
    async batch(statements: D1PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
function ready(model: string) {
  sqlite
    .prepare("UPDATE benchmark_profiles SET status = 'ready', run_id = ? WHERE model = ?")
    .run(`run-${model}`, model);
}
beforeEach(() => {
  vi.clearAllMocks();
  afterOwnerEnumeration = undefined;
  afterOwnerSnapshotWrite = undefined;
  beforeOwnerSnapshotWrite = undefined;
  afterOwnerRowRead = undefined;
  failOwnerReads = new Set();
  writes = [];
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE benchmark_subscriptions (router TEXT, owner_type TEXT, owner_id TEXT, revision TEXT, snapshot TEXT, updated_at TEXT, PRIMARY KEY(router, owner_type, owner_id));
    CREATE TABLE benchmark_daily_alias_sync (router TEXT PRIMARY KEY, day TEXT, attempts INTEGER, platform_status TEXT, platform_error TEXT, owner_cursor_type TEXT, owner_cursor_id TEXT, owner_pages INTEGER, owner_done INTEGER, updated_at TEXT);
    CREATE TABLE config_decider_models (router TEXT, model TEXT);
    CREATE TABLE benchmark_profiles (router TEXT, model TEXT, variant TEXT, engine_identity TEXT, repetitions INTEGER, status TEXT, run_id TEXT, requested_at TEXT, updated_at TEXT, platform_requested INTEGER, user_requested INTEGER, PRIMARY KEY(router, model, variant, engine_identity, repetitions));
  `);
  env = { BENCH_DB: d1(sqlite) } as Env;
  vi.mocked(getBenchmarkConfig).mockResolvedValue(config);
  vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/M'));
  vi.mocked(listReadyCurrentProfilesForEntries).mockImplementation(async (_db, _current, entries) =>
    entries.flatMap(entry => {
      const row = sqlite
        .prepare(
          "SELECT model, variant, run_id FROM benchmark_profiles WHERE model = ? AND variant = ? AND status = 'ready'"
        )
        .get(entry.model, entry.variant ?? '');
      return row ? [row as { model: string; variant: string; run_id: string }] : [];
    })
  );
});
afterEach(() => sqlite.close());

async function initialReady() {
  await syncSubscriptionSnapshot(env, config, owner, pool);
  ready('vendor/M');
  return servingSubscriptionSnapshot(env.BENCH_DB, config, owner);
}
describe('saved daily benchmark subscriptions', () => {
  it('does not create an empty subscription for an owner without a pool', async () => {
    expect(await syncSubscriptionSnapshot(env, config, owner, [])).toEqual([]);
    expect(sqlite.prepare('SELECT * FROM benchmark_subscriptions').all()).toEqual([]);
    expect(fetchExecutableBenchmarkModelCatalog).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('does not rewrite unchanged serving snapshots or already-admitted profiles', async () => {
    await initialReady();
    writes = [];
    await servingSubscriptionSnapshot(env.BENCH_DB, config, owner);
    expect(writes).toEqual([]);
    await syncSubscriptionSnapshot(env, config, owner, pool);
    expect(writes.every(write => write.changes === 0)).toBe(true);
    expect(writes.some(write => write.sql.includes('UPDATE benchmark_subscriptions'))).toBe(false);
  });

  it.each(['~vendor/latest', 'vendor/M'])(
    'serves the initially ready subset for %s and adds later-ready variants',
    async model => {
      vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
        BenchmarkModelCatalogSchema.parse({
          data: [
            { id: '~vendor/latest', alias_target: 'vendor/M' },
            {
              id: 'vendor/M',
              opencode: {
                variants: {
                  low: { reasoning: { effort: 'low' } },
                  high: { reasoning: { effort: 'high' } },
                },
              },
            },
          ],
        })
      );
      await syncSubscriptionSnapshot(env, config, owner, [{ model }]);
      sqlite
        .prepare(
          "UPDATE benchmark_profiles SET status = 'ready', run_id = 'run-low' WHERE variant = 'low'"
        )
        .run();
      sqlite
        .prepare("UPDATE benchmark_profiles SET status = 'failed' WHERE variant = 'high'")
        .run();
      expect(
        snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
      ).toEqual([{ model: 'vendor/M', variant: 'low' }]);
      ready('vendor/M');
      expect(
        snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
      ).toEqual([
        { model: 'vendor/M', variant: 'low' },
        { model: 'vendor/M', variant: 'high' },
      ]);
    }
  );

  it('repairs unresolved first subscriptions only on explicit re-registration', async () => {
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
      BenchmarkModelCatalogSchema.parse({ data: [] })
    );
    const unresolved = await syncSubscriptionSnapshot(env, config, owner, pool);
    expect(unresolved[0].pairs).toEqual([]);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    expect(await syncSubscriptionSnapshot(env, config, owner, pool)).toEqual(unresolved);
    expect(fetchExecutableBenchmarkModelCatalog).toHaveBeenCalledTimes(1);
    const repaired = await syncSubscriptionSnapshot(env, config, owner, pool, {
      retryUnresolved: true,
    });
    expect(snapshotPairs(repaired)).toEqual([{ model: 'vendor/N', variant: null }]);
    expect(repaired[0].resolutionError).toBeNull();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/M'));
    expect(
      snapshotPairs(
        await syncSubscriptionSnapshot(env, config, owner, pool, { retryUnresolved: true })
      )
    ).toEqual([{ model: 'vendor/N', variant: null }]);
  });

  it('keeps the saved concrete target on ordinary reads and full-pool synchronization', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    const snapshot = await syncSubscriptionSnapshot(env, config, owner, pool);
    expect(snapshotPairs(snapshot)).toEqual([{ model: 'vendor/M', variant: null }]);
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    expect(fetchExecutableBenchmarkModelCatalog).toHaveBeenCalledTimes(1);
    expect(
      mapSubscriptionStatuses(snapshot, [
        { entry: { model: 'vendor/M', variant: null }, status: 'ready', failureReason: null },
      ])
    ).toEqual([
      { entry: { model: '~vendor/latest', variant: null }, status: 'ready', failureReason: null },
    ]);
  });

  it('does not remeasure unchanged daily targets or charge a request ledger', async () => {
    await initialReady();
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(sqlite.prepare('SELECT model, status, run_id FROM benchmark_profiles').all()).toEqual([
      { model: 'vendor/M', status: 'ready', run_id: 'run-vendor/M' },
    ]);
  });

  it('reuses the exact ready target measured for another owner on a daily retarget', async () => {
    await initialReady();
    await syncSubscriptionSnapshot(
      env,
      config,
      { ownerType: 'org', ownerId: 'other-owner' },
      [{ model: 'vendor/N' }],
      { catalog: catalog('vendor/N') }
    );
    ready('vendor/N');
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/N', variant: null }]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM benchmark_profiles').get()).toEqual({
      count: 2,
    });
    expect(
      sqlite.prepare("SELECT status, run_id FROM benchmark_profiles WHERE model = 'vendor/N'").get()
    ).toEqual({ status: 'ready', run_id: 'run-vendor/N' });
  });

  it('retains the previous serving target until every replacement pair is ready, including failures', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner))).toEqual(
      [{ model: 'vendor/N', variant: null }]
    );
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'failed' WHERE model = 'vendor/N'")
      .run();
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    ready('vendor/N');
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/N', variant: null }]);
  });

  it('preserves the previous table target on resolution failure', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
      BenchmarkModelCatalogSchema.parse({ data: [] })
    );
    await dailyReconcileSubscriptions(env, 'efficient');
    const snapshot = await servingSubscriptionSnapshot(env.BENCH_DB, config, owner);
    expect(snapshot[0].resolutionError).toMatch(/unavailable/);
    expect(snapshotPairs(snapshot, true)).toEqual([{ model: 'vendor/M', variant: null }]);
  });

  it('does not follow removed aliases and resolves a re-added subscription fresh', async () => {
    await initialReady();
    await syncSubscriptionSnapshot(env, config, owner, []);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM benchmark_profiles WHERE model = 'vendor/N'")
        .get()
    ).toEqual({ count: 0 });
    const readded = await syncSubscriptionSnapshot(env, config, owner, pool);
    expect(snapshotPairs(readded)).toEqual([{ model: 'vendor/N', variant: null }]);
    expect(snapshotPairs(readded, true)).toEqual([]);
  });

  it('uses a prior pool snapshot only on an explicit compensating restore', async () => {
    await initialReady();
    await syncSubscriptionSnapshot(env, config, owner, []);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    const restored = await syncSubscriptionSnapshot(env, config, owner, pool, {
      restorePrevious: true,
    });
    expect(snapshotPairs(restored, true)).toEqual([{ model: 'vendor/M', variant: null }]);
    expect(fetchExecutableBenchmarkModelCatalog).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid_snapshot', 'owner_sync'])(
    'isolates %s failures so a later owner still retargets',
    async category => {
      await initialReady();
      const other = { ownerType: 'user' as const, ownerId: 'zz-later-owner' };
      await syncSubscriptionSnapshot(env, config, other, pool);
      if (category === 'invalid_snapshot') {
        sqlite
          .prepare('UPDATE benchmark_subscriptions SET snapshot = ? WHERE owner_id = ?')
          .run('{"entries":"invalid"}', owner.ownerId);
      } else {
        failOwnerReads = new Set([owner.ownerId]);
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
      await dailyReconcileSubscriptions(env, 'efficient');
      expect(
        snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', other))
      ).toEqual([{ model: 'vendor/N', variant: null }]);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: 'benchmark_subscription_daily_failed',
          category,
          router: 'efficient',
        })
      );
      warn.mockRestore();
    }
  );

  it('retries a daily CAS loss using the freshly saved pool membership', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
      BenchmarkModelCatalogSchema.parse({
        data: [
          { id: '~vendor/latest', alias_target: 'vendor/N' },
          { id: 'vendor/N' },
          { id: 'vendor/added' },
        ],
      })
    );
    beforeOwnerSnapshotWrite = async () => {
      await syncSubscriptionSnapshot(env, config, owner, [{ model: 'vendor/added' }]);
    };
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner))).toEqual(
      [{ model: 'vendor/added', variant: null }]
    );
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM benchmark_profiles WHERE model = 'vendor/N'")
        .get()
    ).toEqual({ count: 0 });
  });

  it('bounds daily CAS retries and logs only a stable failure category', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    let attempts = 0;
    const conflict = async () => {
      attempts++;
      sqlite
        .prepare('UPDATE benchmark_subscriptions SET revision = ? WHERE owner_id = ?')
        .run(`concurrent-${attempts}`, owner.ownerId);
      beforeOwnerSnapshotWrite = conflict;
    };
    beforeOwnerSnapshotWrite = conflict;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(attempts).toBe(4);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: 'benchmark_subscription_daily_failed',
        category: 'concurrent_change',
        router: 'efficient',
      })
    );
    expect(snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner))).toEqual(
      [{ model: 'vendor/M', variant: null }]
    );
    warn.mockRestore();
  });

  it('fences an unchanged snapshot read against concurrent removal', async () => {
    await initialReady();
    afterOwnerRowRead = async () => {
      await syncSubscriptionSnapshot(env, config, owner, []);
    };
    await expect(servingSubscriptionSnapshot(env.BENCH_DB, config, owner)).rejects.toThrow(
      'changed during table assembly'
    );
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([]);
  });

  it('waits for all variants of the replacement before serving any of them', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(
      BenchmarkModelCatalogSchema.parse({
        data: [
          { id: '~vendor/latest', alias_target: 'vendor/N' },
          {
            id: 'vendor/N',
            opencode: {
              variants: {
                low: { reasoning: { effort: 'low' } },
                high: { reasoning: { effort: 'high' } },
              },
            },
          },
        ],
      })
    );
    await dailyReconcileSubscriptions(env, 'efficient');
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'ready', run_id = 'run-N-low' WHERE model = 'vendor/N' AND variant = 'low'"
      )
      .run();
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    ready('vendor/N');
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([
      { model: 'vendor/N', variant: 'low' },
      { model: 'vendor/N', variant: 'high' },
    ]);
  });

  it('retries a failed daily resolution on a later tick the same day', async () => {
    await initialReady();
    const previous = await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner);
    vi.mocked(fetchExecutableBenchmarkModelCatalog)
      .mockRejectedValueOnce(new Error('Catalog unavailable'))
      .mockResolvedValue(catalog('vendor/N'));
    const failed = await dailyReconcileSubscriptions(env, 'efficient');
    expect(failed.platform).toEqual({
      status: 'pending',
      attempts: 1,
      error: 'Catalog unavailable',
    });
    expect(failed.owners.status).toBe('pending');
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual(previous);
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);

    const retried = await continueDailyReconcile(env, 'efficient');
    expect(retried?.platform.status).toBe('ok');
    expect(retried?.owners.status).toBe('ok');
    expect(snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner))).toEqual(
      [{ model: 'vendor/N', variant: null }]
    );
  });

  it('stops retrying a daily resolution that failed all day', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockRejectedValue(
      new Error('Catalog unavailable')
    );
    const now = new Date('2026-11-20T05:00:00.000Z');
    let result = await dailyReconcileSubscriptions(env, 'efficient', { now });
    for (let tick = 0; tick < 40 && result.platform.status === 'pending'; tick++) {
      const next = await continueDailyReconcile(env, 'efficient', { now });
      if (!next) break;
      result = next;
    }
    expect(result.platform.status).toBe('failed');
    expect(sqlite.prepare('SELECT attempts FROM benchmark_daily_alias_sync').get()).toEqual({
      attempts: 30,
    });
    // Platform resolution stops for the day; the owner pass does not, so a tick still
    // runs and the platform attempts stay spent instead of incrementing.
    const next = await continueDailyReconcile(env, 'efficient', { now });
    expect(next?.platform.status).toBe('failed');
    expect(next?.owners.status).toBe('pending');
    expect(sqlite.prepare('SELECT attempts FROM benchmark_daily_alias_sync').get()).toEqual({
      attempts: 30,
    });
  });

  it('does not reconcile a new day before its daily run', async () => {
    await initialReady();
    await dailyReconcileSubscriptions(env, 'efficient', {
      now: new Date('2026-11-19T05:00:00.000Z'),
    });
    expect(
      await continueDailyReconcile(env, 'efficient', { now: new Date('2026-11-20T00:10:00.000Z') })
    ).toBeNull();
  });

  it('re-resolves frontier owners as well as efficient ones', async () => {
    const frontierConfig = { ...config, router: 'frontier' as const };
    vi.mocked(getBenchmarkConfig).mockImplementation(async (_db, router) =>
      router === 'frontier' ? frontierConfig : config
    );
    await syncSubscriptionSnapshot(env, frontierConfig, owner, pool);
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    const result = await dailyReconcileSubscriptions(env, 'frontier');
    expect(result.owners.status).toBe('ok');
    expect(snapshotPairs(await loadSubscriptionSnapshot(env.BENCH_DB, 'frontier', owner))).toEqual([
      { model: 'vendor/N', variant: null },
    ]);
  });

  it('reconciles every owner across bounded pages when most of them fail', async () => {
    const broken = Array.from({ length: 150 }, (_, index) => `broken-${index}`);
    const healthy = Array.from({ length: 50 }, (_, index) => `healthy-${index}`);
    for (const ownerId of [...broken, ...healthy])
      await syncSubscriptionSnapshot(env, config, { ownerType: 'user', ownerId }, pool);
    failOwnerReads = new Set(broken);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));

    const first = await dailyReconcileSubscriptions(env, 'efficient');
    expect(first.owners.status).toBe('pending');
    expect(first.owners.pages).toBe(2);
    const second = await continueDailyReconcile(env, 'efficient');
    expect(second?.owners.status).toBe('ok');
    failOwnerReads = new Set();
    for (const ownerId of healthy)
      expect(
        snapshotPairs(
          await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', { ownerType: 'user', ownerId })
        )
      ).toEqual([{ model: 'vendor/N', variant: null }]);
    expect(
      snapshotPairs(
        await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
          ownerType: 'user',
          ownerId: broken[0],
        })
      )
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('"category":"owner_sync"'))
    ).toHaveLength(150);
    warn.mockRestore();
  });

  it('does not spend the platform attempt budget on ticks that already resolved it', async () => {
    await initialReady();
    for (let index = 0; index < 250; index++)
      await syncSubscriptionSnapshot(
        env,
        config,
        { ownerType: 'user', ownerId: `user-${String(index).padStart(3, '0')}` },
        pool
      );
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    const now = new Date('2026-11-20T05:00:00.000Z');
    const first = await dailyReconcileSubscriptions(env, 'efficient', { now });
    expect(first.platform.status).toBe('ok');
    expect(first.owners.status).toBe('pending');
    expect(first.owners.pages).toBe(2);
    expect(sqlite.prepare('SELECT attempts FROM benchmark_daily_alias_sync').get()).toEqual({
      attempts: 0,
    });

    const later = await continueDailyReconcile(env, 'efficient', { now });
    expect(later?.owners.status).toBe('ok');
    expect(sqlite.prepare('SELECT attempts FROM benchmark_daily_alias_sync').get()).toEqual({
      attempts: 0,
    });
    expect(
      snapshotPairs(
        await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
          ownerType: 'user',
          ownerId: 'user-000',
        })
      )
    ).toEqual([{ model: 'vendor/N', variant: null }]);

    // A pool past the page budget ends the day without a platform attempt.
    sqlite.prepare('UPDATE benchmark_daily_alias_sync SET owner_pages = 100, owner_done = 0').run();
    expect(await continueDailyReconcile(env, 'efficient', { now })).toBeNull();
  });

  it('finishes the owner pages on the same day after the catalog recovers', async () => {
    await initialReady();
    for (let index = 0; index < 250; index++)
      await syncSubscriptionSnapshot(
        env,
        config,
        { ownerType: 'user', ownerId: `user-${String(index).padStart(3, '0')}` },
        pool
      );
    const now = new Date('2026-11-20T05:00:00.000Z');
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockRejectedValue(
      new Error('Catalog unavailable')
    );
    let result = await dailyReconcileSubscriptions(env, 'efficient', { now });
    for (let tick = 0; tick < 40 && result.platform.status === 'pending'; tick++) {
      const next = await continueDailyReconcile(env, 'efficient', { now });
      if (!next) break;
      result = next;
    }
    expect(result.platform.status).toBe('failed');
    expect(result.owners.status).toBe('pending');
    expect(
      sqlite.prepare('SELECT attempts, owner_pages FROM benchmark_daily_alias_sync').get()
    ).toEqual({ attempts: 30, owner_pages: 0 });

    // The catalog recovers: the platform budget is spent, the owner pages are not.
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    let owners = await continueDailyReconcile(env, 'efficient', { now });
    expect(owners?.platform.status).toBe('failed');
    expect(owners?.owners.pages).toBe(2);
    for (let tick = 0; tick < 10 && owners?.owners.status === 'pending'; tick++)
      owners = await continueDailyReconcile(env, 'efficient', { now });
    expect(owners?.owners.status).toBe('ok');
    expect(
      snapshotPairs(
        await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', {
          ownerType: 'user',
          ownerId: 'user-249',
        })
      )
    ).toEqual([{ model: 'vendor/N', variant: null }]);
    expect(sqlite.prepare('SELECT attempts FROM benchmark_daily_alias_sync').get()).toEqual({
      attempts: 30,
    });
    expect(await continueDailyReconcile(env, 'efficient', { now })).toBeNull();
  });

  it('keeps serving a target that lost readiness instead of dropping the alias', async () => {
    await initialReady();
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'failed', run_id = NULL WHERE model = 'vendor/M'"
      )
      .run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      snapshotPairs(await servingSubscriptionSnapshot(env.BENCH_DB, config, owner), true)
    ).toEqual([{ model: 'vendor/M', variant: null }]);
    expect(warn.mock.calls.map(([message]) => JSON.parse(String(message)).event)).toContain(
      'benchmark_alias_serving_held'
    );
    warn.mockRestore();
  });

  it.each(['vendor/M', 'vendor/N'])(
    'fences platform config changes when resolution returns %s',
    async target => {
      const platformConfig = { ...config, deciderModels: [{ id: '~vendor/latest' }] };
      sqlite
        .prepare("INSERT INTO config_decider_models VALUES ('efficient', '~vendor/latest')")
        .run();
      await syncSubscriptionSnapshot(env, platformConfig, PLATFORM_SUBSCRIPTION_OWNER, pool);
      const previous = await loadSubscriptionSnapshot(
        env.BENCH_DB,
        'efficient',
        PLATFORM_SUBSCRIPTION_OWNER
      );
      vi.mocked(fetchExecutableBenchmarkModelCatalog).mockImplementation(async () => {
        sqlite.prepare("UPDATE config_decider_models SET model = 'vendor/N'").run();
        return catalog(target);
      });
      await expect(
        syncSubscriptionSnapshot(env, platformConfig, PLATFORM_SUBSCRIPTION_OWNER, pool, {
          daily: true,
        })
      ).rejects.toThrow(/changed concurrently/);
      expect(
        await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', PLATFORM_SUBSCRIPTION_OWNER)
      ).toEqual(previous);
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM benchmark_profiles WHERE model = 'vendor/N'")
          .get()
      ).toEqual({ count: 0 });
    }
  );

  it('does not resurrect an owner removed after daily enumeration', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    afterOwnerEnumeration = async () => {
      await syncSubscriptionSnapshot(env, config, owner, []);
    };
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM benchmark_profiles WHERE model = 'vendor/N'")
        .get()
    ).toEqual({ count: 0 });
  });

  it('does not admit a daily replacement after its subscription was removed following the snapshot CAS', async () => {
    await initialReady();
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(catalog('vendor/N'));
    afterOwnerSnapshotWrite = async () => {
      await syncSubscriptionSnapshot(env, config, owner, []);
    };
    await dailyReconcileSubscriptions(env, 'efficient');
    expect(await loadSubscriptionSnapshot(env.BENCH_DB, 'efficient', owner)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM benchmark_profiles WHERE model = 'vendor/N'")
        .get()
    ).toEqual({ count: 0 });
  });

  it('refuses a non-enrollable model as a subscription target while admitting the plain model', async () => {
    const blocked = 'openai/gpt-6.2-astra-fast';
    const plain = 'openai/gpt-6.2-astra';
    const both = BenchmarkModelCatalogSchema.parse({
      data: [
        { id: blocked, supported_parameters: ['tools'] },
        { id: plain, supported_parameters: ['tools'] },
      ],
    });
    vi.mocked(fetchExecutableBenchmarkModelCatalog).mockResolvedValue(both);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = await syncSubscriptionSnapshot(env, config, owner, [
      { model: blocked },
      { model: plain },
    ]);
    // The blocked model resolves no pairs and carries the refusal reason; the plain
    // model still enrolls its pending row.
    expect(snapshot).toEqual([
      {
        model: blocked,
        pairs: [],
        servingPairs: [],
        resolutionError: NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
      },
      {
        model: plain,
        pairs: [{ model: plain, variant: null }],
        servingPairs: [],
        resolutionError: null,
      },
    ]);
    const rows = sqlite
      .prepare('SELECT model FROM benchmark_profiles ORDER BY model')
      .all()
      .map(row => String(row.model));
    expect(rows).toEqual([plain]);
    expect(warn.mock.calls.map(([message]) => JSON.parse(String(message)).event)).toContain(
      'benchmark_model_enrollment_blocked'
    );
    warn.mockRestore();
  });

  it('drops an already saved target of a model added to the non-enrollable list', async () => {
    // Simulate a target saved before the model joined the list: write the snapshot
    // directly, with a ready measurement backing it, bypassing resolution.
    const blocked = 'openai/gpt-6.2-astra-fast';
    const saved = [
      {
        model: blocked,
        pairs: [{ model: blocked, variant: null }],
        servingPairs: [{ model: blocked, variant: null }],
        resolutionError: null,
      },
    ];
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
         VALUES ('efficient', ?, ?, 'rev-1', ?, '2026-01-01T00:00:00.000Z')`
      )
      .run(owner.ownerType, owner.ownerId, JSON.stringify({ entries: saved, previousEntries: [] }));
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status, run_id, requested_at, updated_at, platform_requested, user_requested)
         VALUES ('efficient', ?, '', 'engine', 1, 'ready', 'run-x', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0, 1)`
      )
      .run(blocked);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconciled = await syncSubscriptionSnapshot(env, config, owner, [{ model: blocked }], {
      daily: true,
      catalog: BenchmarkModelCatalogSchema.parse({
        data: [{ id: blocked, supported_parameters: ['tools'] }, { id: 'vendor/M' }],
      }),
    });
    // No target follows it and it stops serving, so the publish is not held on a
    // replacement that never comes; the measured row stays readable.
    expect(reconciled[0]).toEqual({
      model: blocked,
      pairs: [],
      servingPairs: [],
      resolutionError: NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
    });
    expect(
      sqlite.prepare('SELECT status FROM benchmark_profiles WHERE model = ?').get(blocked)
    ).toEqual({ status: 'ready' });
    expect(warn.mock.calls.map(([message]) => JSON.parse(String(message)).event)).toContain(
      'benchmark_model_enrollment_blocked'
    );
    warn.mockRestore();
  });

  it('excludes an alias whose concrete target is blocked instead of leaving it unresolved', async () => {
    const alias = '~openai/astra-latest';
    const blocked = 'openai/gpt-6.2-astra-fast';
    const resolved = await syncSubscriptionSnapshot(env, config, owner, [{ model: alias }], {
      catalog: BenchmarkModelCatalogSchema.parse({
        data: [
          { id: alias, alias_target: blocked },
          { id: blocked, supported_parameters: ['tools'] },
        ],
      }),
    });
    // Not the generic catalog-unavailable error: a settled exclusion the publish can drop.
    expect(resolved[0]).toEqual({
      model: alias,
      pairs: [],
      servingPairs: [],
      resolutionError: NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
    });
  });
});
