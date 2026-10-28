import * as z from 'zod';
import {
  benchmarkPairKey,
  resolveBenchmarkIdentity,
  type AutoRouter,
  type BenchmarkConfig,
  type BenchmarkPair,
  type BenchmarkProfileEntryStatus,
} from '@kilocode/auto-routing-contracts';
import { fetchExecutableBenchmarkModelCatalog } from './executable-models';
import { platformRegistryEntries, type BenchmarkModelCatalogSchema } from './platform-models';
import { getBenchmarkConfig } from './config';
import { listReadyCurrentProfilesForEntries } from './db';
import { computeEngineIdentity } from './run';

const PairSchema = z.object({ model: z.string().min(1), variant: z.string().nullable() });
const SnapshotSchema = z.array(
  z.object({
    model: z.string().min(1),
    pairs: z.array(PairSchema),
    servingPairs: z.array(PairSchema),
    resolutionError: z.string().nullable(),
  })
);
const StoredSnapshotSchema = z.object({ entries: SnapshotSchema, previousEntries: SnapshotSchema });
export type SubscriptionSnapshot = z.infer<typeof SnapshotSchema>;
export type SubscriptionOwner = { ownerType: 'platform' | 'user' | 'org'; ownerId: string };
export const PLATFORM_SUBSCRIPTION_OWNER: SubscriptionOwner = {
  ownerType: 'platform',
  ownerId: '',
};
type SnapshotRow = {
  router: AutoRouter;
  owner_type: SubscriptionOwner['ownerType'];
  owner_id: string;
  revision: string;
  snapshot: string;
};

function uniquePairs(pairs: readonly BenchmarkPair[]): BenchmarkPair[] {
  return [...new Map(pairs.map(pair => [benchmarkPairKey(pair), pair])).values()];
}
export function snapshotPairs(snapshot: SubscriptionSnapshot, serving = false): BenchmarkPair[] {
  return uniquePairs(snapshot.flatMap(entry => (serving ? entry.servingPairs : entry.pairs)));
}
export function mapSubscriptionStatuses(
  snapshot: SubscriptionSnapshot,
  statuses: readonly BenchmarkProfileEntryStatus[]
): BenchmarkProfileEntryStatus[] {
  const byPair = new Map(statuses.map(status => [benchmarkPairKey(status.entry), status]));
  return snapshot.flatMap((selected): BenchmarkProfileEntryStatus[] =>
    selected.resolutionError
      ? [
          {
            entry: { model: selected.model, variant: null },
            status: 'failed' as const,
            failureReason: selected.resolutionError,
          },
        ]
      : selected.pairs.map(pair => ({
          ...(byPair.get(benchmarkPairKey(pair)) ?? {
            status: 'failed' as const,
            failureReason: 'Benchmark profile missing; retry to request it.',
          }),
          entry: { model: selected.model, variant: pair.variant },
        }))
  );
}
async function readRow(
  db: D1Database,
  router: AutoRouter,
  owner: SubscriptionOwner
): Promise<SnapshotRow | null> {
  return db
    .prepare(
      'SELECT router, owner_type, owner_id, revision, snapshot FROM benchmark_subscriptions WHERE router = ? AND owner_type = ? AND owner_id = ?'
    )
    .bind(router, owner.ownerType, owner.ownerId)
    .first<SnapshotRow>();
}
export async function loadSubscriptionSnapshot(
  db: D1Database,
  router: AutoRouter,
  owner: SubscriptionOwner
): Promise<SubscriptionSnapshot> {
  const row = await readRow(db, router, owner);
  if (!row) return [];
  return StoredSnapshotSchema.parse(JSON.parse(row.snapshot)).entries;
}
export function resolveSubscriptionSnapshot(
  models: readonly { model: string }[],
  previous: SubscriptionSnapshot,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema> | null,
  daily = false,
  retryUnresolved = false
): SubscriptionSnapshot {
  const oldByModel = new Map(previous.map(entry => [entry.model, entry]));
  return models.map(({ model }) => {
    const old = oldByModel.get(model);
    if (old && !daily && !(retryUnresolved && old.pairs.length === 0)) return old;
    try {
      if (!catalog) throw new Error('Model resolution is unavailable.');
      const pairs = platformRegistryEntries({ deciderModels: [{ id: model }] }, catalog);
      if (!pairs.length || pairs.some(pair => pair.model.startsWith('~')))
        throw new Error('Alias target is unavailable.');
      return { model, pairs, servingPairs: old?.servingPairs ?? [], resolutionError: null };
    } catch {
      return {
        model,
        pairs: old?.pairs ?? [],
        servingPairs: old?.servingPairs ?? [],
        resolutionError: 'Model is unavailable in the executable benchmark catalog.',
      };
    }
  });
}
async function replaceSnapshot(
  db: D1Database,
  router: AutoRouter,
  owner: SubscriptionOwner,
  previous: SnapshotRow | null,
  snapshot: SubscriptionSnapshot
): Promise<string | null> {
  const old = previous
    ? StoredSnapshotSchema.parse(JSON.parse(previous.snapshot))
    : { entries: [], previousEntries: [] };
  const membershipChanged =
    JSON.stringify(old.entries.map(entry => entry.model)) !==
    JSON.stringify(snapshot.map(entry => entry.model));
  const serialized = JSON.stringify({
    entries: snapshot,
    previousEntries: membershipChanged ? old.entries : old.previousEntries,
  });
  const platformGuard =
    owner.ownerType === 'platform'
      ? ' AND NOT EXISTS (SELECT 1 FROM config_decider_models WHERE router = ? AND model NOT IN (SELECT value FROM json_each(?))) AND (SELECT COUNT(*) FROM config_decider_models WHERE router = ?) = json_array_length(?)'
      : '';
  const models = JSON.stringify(snapshot.map(entry => entry.model));
  const guardBindings = owner.ownerType === 'platform' ? [router, models, router, models] : [];
  if (previous?.snapshot === serialized) {
    const current = await db
      .prepare(
        `SELECT revision FROM benchmark_subscriptions WHERE router = ? AND owner_type = ? AND owner_id = ? AND revision = ?${platformGuard}`
      )
      .bind(router, owner.ownerType, owner.ownerId, previous.revision, ...guardBindings)
      .first<{ revision: string }>();
    return current?.revision ?? null;
  }
  const revision = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = previous
    ? await db
        .prepare(
          `UPDATE benchmark_subscriptions SET revision = ?, snapshot = ?, updated_at = ? WHERE router = ? AND owner_type = ? AND owner_id = ? AND revision = ?${platformGuard}`
        )
        .bind(
          revision,
          serialized,
          now,
          router,
          owner.ownerType,
          owner.ownerId,
          previous.revision,
          ...guardBindings
        )
        .run()
    : await db
        .prepare(
          `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1${platformGuard} ON CONFLICT DO NOTHING`
        )
        .bind(router, owner.ownerType, owner.ownerId, revision, serialized, now, ...guardBindings)
        .run();
  return (result.meta.changes ?? 0) > 0 ? revision : null;
}
export async function syncSubscriptionSnapshot(
  env: Env,
  config: BenchmarkConfig,
  owner: SubscriptionOwner,
  models: readonly { model: string }[],
  options: {
    daily?: boolean;
    fetchImpl?: typeof fetch;
    admit?: boolean;
    retryUnresolved?: boolean;
    restorePrevious?: boolean;
    catalog?: z.infer<typeof BenchmarkModelCatalogSchema>;
  } = {}
): Promise<SubscriptionSnapshot> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await readRow(env.BENCH_DB, config.router, owner);
    if (!previous && models.length === 0) return [];
    const stored = previous
      ? StoredSnapshotSchema.parse(JSON.parse(previous.snapshot))
      : { entries: [], previousEntries: [] };
    const old = options.restorePrevious
      ? [...stored.previousEntries, ...stored.entries]
      : stored.entries;
    const needsResolution =
      options.daily ||
      models.some(
        model =>
          !old.some(
            entry =>
              entry.model === model.model && (!options.retryUnresolved || entry.pairs.length > 0)
          )
      );
    const catalog = needsResolution
      ? (options.catalog ??
        (await fetchExecutableBenchmarkModelCatalog(
          env,
          resolveBenchmarkIdentity(config),
          options.fetchImpl
        )))
      : null;
    const snapshot = resolveSubscriptionSnapshot(
      models,
      old,
      catalog,
      options.daily,
      options.retryUnresolved
    );
    const revision = await replaceSnapshot(env.BENCH_DB, config.router, owner, previous, snapshot);
    if (!revision) continue;
    if (options.admit !== false)
      await admitSubscriptionPairs(env.BENCH_DB, config, owner, snapshotPairs(snapshot), revision);
    return snapshot;
  }
  throw new Error('Benchmark subscriptions changed concurrently; retry the request.');
}
async function admitSubscriptionPairs(
  db: D1Database,
  config: BenchmarkConfig,
  owner: SubscriptionOwner,
  pairs: readonly BenchmarkPair[],
  revision: string
): Promise<void> {
  const now = new Date().toISOString();
  const flag = owner.ownerType === 'platform' ? 'platform_requested' : 'user_requested';
  if (!pairs.length) return;
  await db.batch(
    pairs.map(pair =>
      db
        .prepare(
          `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status, requested_at, updated_at, platform_requested, user_requested) SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM benchmark_subscriptions WHERE router = ? AND owner_type = ? AND owner_id = ? AND revision = ?) ON CONFLICT (router, model, variant, engine_identity, repetitions) DO UPDATE SET ${flag} = 1 WHERE ${flag} = 0`
        )
        .bind(
          config.router,
          pair.model,
          pair.variant ?? '',
          computeEngineIdentity('decider', config.router),
          config.deciderRepetitions,
          now,
          now,
          owner.ownerType === 'platform' ? 1 : 0,
          owner.ownerType === 'platform' ? 0 : 1,
          config.router,
          owner.ownerType,
          owner.ownerId,
          revision
        )
    )
  );
}
export async function dailyReconcileSubscriptions(
  env: Env,
  router: AutoRouter,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) return;
  const catalog = await fetchExecutableBenchmarkModelCatalog(
    env,
    resolveBenchmarkIdentity(config),
    fetchImpl
  );
  try {
    await syncSubscriptionSnapshot(
      env,
      config,
      PLATFORM_SUBSCRIPTION_OWNER,
      config.deciderModels.map(model => ({ model: model.id })),
      { daily: true, catalog }
    );
  } catch {
    console.warn(
      JSON.stringify({
        event: 'benchmark_subscription_daily_failed',
        category: 'platform_sync',
        router,
      })
    );
  }
  if (router === 'frontier') return;
  const rows = await env.BENCH_DB.prepare(
    "SELECT router, owner_type, owner_id, revision, snapshot FROM benchmark_subscriptions WHERE router = ? AND owner_type != 'platform'"
  )
    .bind(router)
    .all<SnapshotRow>();
  for (const row of rows.results) {
    try {
      const owner = { ownerType: row.owner_type, ownerId: row.owner_id };
      let reconciled = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await readRow(env.BENCH_DB, router, owner);
        if (!current) {
          reconciled = true;
          break;
        }
        const previous = StoredSnapshotSchema.parse(JSON.parse(current.snapshot)).entries;
        if (!previous.length) {
          reconciled = true;
          break;
        }
        const snapshot = resolveSubscriptionSnapshot(previous, previous, catalog, true);
        const revision = await replaceSnapshot(env.BENCH_DB, router, owner, current, snapshot);
        if (!revision) continue;
        await admitSubscriptionPairs(
          env.BENCH_DB,
          config,
          owner,
          snapshotPairs(snapshot),
          revision
        );
        reconciled = true;
        break;
      }
      if (!reconciled) {
        console.warn(
          JSON.stringify({
            event: 'benchmark_subscription_daily_failed',
            category: 'concurrent_change',
            router,
          })
        );
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: 'benchmark_subscription_daily_failed',
          category:
            error instanceof z.ZodError || error instanceof SyntaxError
              ? 'invalid_snapshot'
              : 'owner_sync',
          router,
        })
      );
    }
  }
}
export async function servingSubscriptionSnapshot(
  db: D1Database,
  config: BenchmarkConfig,
  owner: SubscriptionOwner
): Promise<SubscriptionSnapshot> {
  const row = await readRow(db, config.router, owner);
  if (!row) return [];
  const snapshot = StoredSnapshotSchema.parse(JSON.parse(row.snapshot)).entries;
  const candidates = snapshotPairs(snapshot);
  const ready = await listReadyCurrentProfilesForEntries(
    db,
    {
      router: config.router,
      engineIdentity: computeEngineIdentity('decider', config.router),
      repetitions: config.deciderRepetitions,
    },
    candidates
  );
  const readyKeys = new Set(
    ready
      .filter(entry => entry.run_id)
      .map(entry => benchmarkPairKey({ model: entry.model, variant: entry.variant || null }))
  );
  const promoted = snapshot.map(entry => {
    if (entry.resolutionError || entry.pairs.length === 0) return entry;
    const targetKeys = new Set(entry.pairs.map(benchmarkPairKey));
    const replacing = entry.servingPairs.some(pair => !targetKeys.has(benchmarkPairKey(pair)));
    const readyPairs = entry.pairs.filter(pair => readyKeys.has(benchmarkPairKey(pair)));
    return replacing && readyPairs.length !== entry.pairs.length
      ? entry
      : { ...entry, servingPairs: readyPairs };
  });
  if (!(await replaceSnapshot(db, config.router, owner, row, promoted)))
    throw new Error('Benchmark subscriptions changed during table assembly.');
  return promoted;
}
