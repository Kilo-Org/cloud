import * as z from 'zod';
import {
  benchmarkPairKey,
  resolveBenchmarkIdentity,
  resolveEffectivePolicy,
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
          resolveEffectivePolicy(config).deciderRepetitions,
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
const DailyAliasSyncRowSchema = z.object({
  day: z.string(),
  attempts: z.number().int().nonnegative(),
  platform_status: z.enum(['pending', 'ok', 'failed']),
  platform_error: z.string().nullable(),
  owner_cursor_type: z.enum(['user', 'org']).nullable(),
  owner_cursor_id: z.string().nullable(),
  owner_pages: z.number().int().nonnegative(),
  owner_done: z.number().int().nonnegative(),
});
type DailyAliasSyncRow = z.infer<typeof DailyAliasSyncRowSchema>;

/**
 * Work bounds for one day's alias sync: total attempts (so a failing day stops instead of
 * retrying every minute until midnight) and owner rows per attempt.
 */
const DAILY_ALIAS_ATTEMPT_LIMIT = 30;
const DAILY_OWNER_PAGE_SIZE = 100;
const DAILY_OWNER_PAGES_PER_TICK = 2;

/** A step that failed this attempt but has attempts left today is `pending`, not `failed`. */
export type DailyAliasPlatform = { attempts: number } & (
  | { status: 'ok' }
  | { status: 'pending' | 'failed'; error: string }
);
export type DailyAliasOwners = { reconciled: number; pages: number } & (
  | { status: 'ok' }
  | { status: 'pending' }
);
export type DailyAliasReconcileResult = {
  router: AutoRouter;
  day: string;
  platform: DailyAliasPlatform;
  owners: DailyAliasOwners;
};

type DailyAliasOptions = { fetchImpl?: typeof fetch; now?: Date };
type OwnerKey = { ownerType: 'user' | 'org'; ownerId: string };
type DailyAliasProgress = {
  day: string;
  attempts: number;
  platformStatus: 'pending' | 'ok' | 'failed';
  platformError: string | null;
  ownerCursor: OwnerKey | null;
  ownerPages: number;
  ownersDone: boolean;
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyProgress(day: string): DailyAliasProgress {
  return {
    day,
    attempts: 0,
    platformStatus: 'pending',
    platformError: null,
    ownerCursor: null,
    ownerPages: 0,
    ownersDone: false,
  };
}

async function readDailyAliasProgress(
  db: D1Database,
  router: AutoRouter,
  day: string
): Promise<DailyAliasProgress | null> {
  const row = await db
    .prepare(
      'SELECT day, attempts, platform_status, platform_error, owner_cursor_type, owner_cursor_id, owner_pages, owner_done FROM benchmark_daily_alias_sync WHERE router = ?'
    )
    .bind(router)
    .first<DailyAliasSyncRow>();
  if (!row) return null;
  const stored = DailyAliasSyncRowSchema.parse(row);
  if (stored.day !== day) return null;
  return {
    day,
    attempts: stored.attempts,
    platformStatus: stored.platform_status,
    platformError: stored.platform_error,
    ownerCursor:
      stored.owner_cursor_type && stored.owner_cursor_id
        ? { ownerType: stored.owner_cursor_type, ownerId: stored.owner_cursor_id }
        : null,
    ownerPages: stored.owner_pages,
    ownersDone: stored.owner_done === 1,
  };
}

/** Starts today's row, keeping an existing one for the same day. */
async function startDailyAliasProgress(
  db: D1Database,
  router: AutoRouter,
  day: string,
  nowIso: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO benchmark_daily_alias_sync (router, day, attempts, platform_status, platform_error, owner_cursor_type, owner_cursor_id, owner_pages, owner_done, updated_at)
       VALUES (?, ?, 0, 'pending', NULL, NULL, NULL, 0, 0, ?)
       ON CONFLICT (router) DO UPDATE SET day = excluded.day, attempts = 0, platform_status = 'pending', platform_error = NULL, owner_cursor_type = NULL, owner_cursor_id = NULL, owner_pages = 0, owner_done = 0, updated_at = excluded.updated_at
       WHERE benchmark_daily_alias_sync.day != excluded.day`
    )
    .bind(router, day, nowIso)
    .run();
}

async function savePlatformOutcome(
  db: D1Database,
  router: AutoRouter,
  progress: DailyAliasProgress,
  nowIso: string
): Promise<void> {
  await db
    .prepare(
      'UPDATE benchmark_daily_alias_sync SET attempts = ?, platform_status = ?, platform_error = ?, updated_at = ? WHERE router = ? AND day = ?'
    )
    .bind(
      progress.attempts,
      progress.platformStatus,
      progress.platformError,
      nowIso,
      router,
      progress.day
    )
    .run();
}

/**
 * Stores one owner page's cursor. Guarded on the cursor the page started from, so two
 * overlapping invocations cannot both advance it and skip rows.
 */
async function saveOwnerPage(
  db: D1Database,
  router: AutoRouter,
  day: string,
  claimedFrom: OwnerKey | null,
  next: OwnerKey | null,
  done: boolean,
  pages: number,
  nowIso: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE benchmark_daily_alias_sync SET owner_cursor_type = ?, owner_cursor_id = ?, owner_done = ?, owner_pages = ?, updated_at = ?
       WHERE router = ? AND day = ? AND COALESCE(owner_cursor_type, '') = ? AND COALESCE(owner_cursor_id, '') = ?`
    )
    .bind(
      next?.ownerType ?? null,
      next?.ownerId ?? null,
      done ? 1 : 0,
      pages,
      nowIso,
      router,
      day,
      claimedFrom?.ownerType ?? '',
      claimedFrom?.ownerId ?? ''
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function reconcileOwner(
  env: Env,
  config: BenchmarkConfig,
  router: AutoRouter,
  owner: SubscriptionOwner,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): Promise<void> {
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
    await admitSubscriptionPairs(env.BENCH_DB, config, owner, snapshotPairs(snapshot), revision);
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
}

type OwnerPage = {
  reconciled: number;
  claimedFrom: OwnerKey | null;
  next: OwnerKey | null;
  done: boolean;
};

/** One keyset page of owner subscriptions, reconciled one owner at a time. */
async function reconcileOwnerPage(
  env: Env,
  config: BenchmarkConfig,
  router: AutoRouter,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  cursor: OwnerKey | null,
  pageSize: number
): Promise<OwnerPage> {
  const keyset = cursor ? 'AND (owner_type > ? OR (owner_type = ? AND owner_id > ?))' : '';
  const rows = await env.BENCH_DB.prepare(
    `SELECT router, owner_type, owner_id, revision, snapshot FROM benchmark_subscriptions
     WHERE router = ? AND owner_type != 'platform' ${keyset}
     ORDER BY owner_type, owner_id LIMIT ?`
  )
    .bind(
      ...(cursor ? [router, cursor.ownerType, cursor.ownerType, cursor.ownerId, pageSize] : [router, pageSize])
    )
    .all<SnapshotRow>();
  let reconciled = 0;
  for (const row of rows.results) {
    const owner = { ownerType: row.owner_type, ownerId: row.owner_id };
    try {
      await reconcileOwner(env, config, router, owner, catalog);
      reconciled += 1;
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
  const last = rows.results.at(-1);
  return {
    reconciled,
    claimedFrom: cursor,
    next:
      last && last.owner_type !== 'platform'
        ? { ownerType: last.owner_type, ownerId: last.owner_id }
        : null,
    done: rows.results.length < pageSize,
  };
}

function aliasStepResult(
  router: AutoRouter,
  progress: DailyAliasProgress,
  owners: { reconciled: number; pages: number }
): DailyAliasReconcileResult {
  return {
    router,
    day: progress.day,
    platform:
      progress.platformStatus === 'ok'
        ? { status: 'ok', attempts: progress.attempts }
        : {
            status: progress.platformStatus === 'failed' ? 'failed' : 'pending',
            attempts: progress.attempts,
            error: progress.platformError ?? 'Model resolution is unavailable.',
          },
    owners: {
      status: progress.ownersDone ? 'ok' : 'pending',
      reconciled: owners.reconciled,
      pages: owners.pages,
    },
  };
}

/**
 * Advances one day's alias sync by a bounded unit: re-resolve the platform aliases if they
 * are not yet resolved today, then reconcile owner subscriptions one keyset page at a time.
 * Every step reports its own outcome, so a failed platform resolution or a failed owner page
 * neither throws nor blocks the rest of the daily branch; `continueDailyReconcile` retries
 * what is left on later ticks until the day's attempt budget is spent.
 */
async function reconcileDailyAliases(
  env: Env,
  router: AutoRouter,
  day: string,
  progress: DailyAliasProgress,
  options: DailyAliasOptions
): Promise<DailyAliasReconcileResult> {
  const nowIso = (options.now ?? new Date()).toISOString();
  const config = await getBenchmarkConfig(env.BENCH_DB, router);
  if (!config) {
    return {
      router,
      day,
      platform: {
        status: 'pending',
        attempts: progress.attempts,
        error: 'Router is not configured.',
      },
      owners: { status: 'pending', reconciled: 0, pages: 0 },
    };
  }
  if (
    (progress.platformStatus === 'ok' && progress.ownersDone) ||
    progress.attempts >= DAILY_ALIAS_ATTEMPT_LIMIT
  ) {
    if (progress.attempts >= DAILY_ALIAS_ATTEMPT_LIMIT && progress.platformStatus === 'pending')
      progress.platformStatus = 'failed';
    return aliasStepResult(router, progress, { reconciled: 0, pages: 0 });
  }

  progress.attempts += 1;
  let catalog: z.infer<typeof BenchmarkModelCatalogSchema> | null = null;
  let catalogError = 'Model resolution is unavailable.';
  try {
    catalog = await fetchExecutableBenchmarkModelCatalog(
      env,
      resolveBenchmarkIdentity(config),
      options.fetchImpl
    );
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }

  if (progress.platformStatus !== 'ok') {
    if (!catalog) {
      progress.platformError = catalogError;
    } else {
      try {
        await syncSubscriptionSnapshot(
          env,
          config,
          PLATFORM_SUBSCRIPTION_OWNER,
          config.deciderModels.map(model => ({ model: model.id })),
          { daily: true, catalog }
        );
        progress.platformStatus = 'ok';
        progress.platformError = null;
      } catch (error) {
        progress.platformError = errorMessage(error);
        console.warn(
          JSON.stringify({
            event: 'benchmark_subscription_daily_failed',
            category: 'platform_sync',
            router,
          })
        );
      }
    }
    if (
      progress.platformStatus !== 'ok' &&
      progress.attempts >= DAILY_ALIAS_ATTEMPT_LIMIT
    )
      progress.platformStatus = 'failed';
  }

  const owners = { reconciled: 0, pages: 0 };
  if (!progress.ownersDone && catalog) {
    try {
      for (let page = 0; page < DAILY_OWNER_PAGES_PER_TICK && !progress.ownersDone; page++) {
        const result = await reconcileOwnerPage(
          env,
          config,
          router,
          catalog,
          progress.ownerCursor,
          DAILY_OWNER_PAGE_SIZE
        );
        const pages = progress.ownerPages + 1;
        const stored = await saveOwnerPage(
          env.BENCH_DB,
          router,
          day,
          result.claimedFrom,
          result.next,
          result.done,
          pages,
          nowIso
        );
        owners.reconciled += result.reconciled;
        owners.pages += 1;
        progress.ownersDone = result.done;
        progress.ownerCursor = result.next;
        progress.ownerPages = pages;
        if (!stored) break;
      }
    } catch {
      console.warn(
        JSON.stringify({
          event: 'benchmark_subscription_daily_failed',
          category: 'owner_page',
          router,
        })
      );
    }
  }

  await savePlatformOutcome(env.BENCH_DB, router, progress, nowIso);
  return aliasStepResult(router, progress, owners);
}

/** Starts today's alias sync, or resumes one already started today. */
export async function dailyReconcileSubscriptions(
  env: Env,
  router: AutoRouter,
  options: DailyAliasOptions = {}
): Promise<DailyAliasReconcileResult> {
  const now = options.now ?? new Date();
  const day = utcDay(now);
  await startDailyAliasProgress(env.BENCH_DB, router, day, now.toISOString());
  const progress = (await readDailyAliasProgress(env.BENCH_DB, router, day)) ?? emptyProgress(day);
  return reconcileDailyAliases(env, router, day, progress, options);
}

/**
 * Continues a daily alias sync the daily cron started today. Returns null before the daily
 * cron has run for the day, and once nothing is left, so the minute tick does no work.
 */
export async function continueDailyReconcile(
  env: Env,
  router: AutoRouter,
  options: DailyAliasOptions = {}
): Promise<DailyAliasReconcileResult | null> {
  const day = utcDay(options.now ?? new Date());
  const progress = await readDailyAliasProgress(env.BENCH_DB, router, day);
  if (
    !progress ||
    (progress.platformStatus === 'ok' && progress.ownersDone) ||
    progress.attempts >= DAILY_ALIAS_ATTEMPT_LIMIT
  )
    return null;
  return reconcileDailyAliases(env, router, day, progress, options);
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
      repetitions: resolveEffectivePolicy(config).deciderRepetitions,
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
    const readyPairs = entry.pairs.filter(pair => readyKeys.has(benchmarkPairKey(pair)));
    // A serving pair leaves only once its replacement is ready: the whole new target set,
    // or — when the target did not move — that same pair measured again. A failed or
    // re-running measurement therefore keeps serving its previous result.
    const movedAway = entry.servingPairs.filter(pair => !targetKeys.has(benchmarkPairKey(pair)));
    if (movedAway.length > 0) {
      if (readyPairs.length === entry.pairs.length) return { ...entry, servingPairs: readyPairs };
      console.warn(
        JSON.stringify({
          event: 'benchmark_alias_serving_held',
          model: entry.model,
          reason: 'replacement_pending',
          held: movedAway,
          pending: entry.pairs.filter(pair => !readyKeys.has(benchmarkPairKey(pair))),
        })
      );
      return entry;
    }
    const kept = entry.servingPairs.filter(pair => !readyKeys.has(benchmarkPairKey(pair)));
    if (kept.length > 0)
      console.warn(
        JSON.stringify({
          event: 'benchmark_alias_serving_held',
          model: entry.model,
          reason: 'readiness_lost',
          held: kept,
        })
      );
    return { ...entry, servingPairs: uniquePairs([...readyPairs, ...kept]) };
  });
  if (!(await replaceSnapshot(db, config.router, owner, row, promoted)))
    throw new Error('Benchmark subscriptions changed during table assembly.');
  return promoted;
}
