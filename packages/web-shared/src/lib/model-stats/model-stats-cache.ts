import 'server-only';

import { ENKRYPT_PUBLICATION_ENABLED } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { enkrypt_sync_state, modelStats, type ModelStats } from '@kilocode/db/schema';
import { desc, eq, sql } from 'drizzle-orm';
import { requireCustomLlmsById } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 1000;

/** The read client a caller loads the snapshot with; `db` is the Frankfurt primary. */
export type ModelStatsLoadClient = typeof db;

export type ModelStatsCacheEntry = Readonly<{ stat: ModelStats; verification: unknown }>;
export type ModelStatsCacheMetadata = Readonly<{
  observedAt: number;
  generation: number;
  /** Lowercased ids of custom LLMs, whose stats must never be published. */
  customLlmIds: ReadonlySet<string>;
}>;
export type ModelStatsSnapshot = ModelStatsCacheMetadata & {
  readonly entries: readonly ModelStatsCacheEntry[];
};

type CacheState = {
  cached: ModelStatsSnapshot | null;
  inFlight: Promise<ModelStatsSnapshot> | null;
  failure: { retryAt: number; error: unknown } | null;
};

/**
 * One snapshot per read client. The web app invalidates this cache right after a
 * model-stats write and must load the primary, while the AI gateway handlers run in
 * `sfo1` and must load the replica. A shared snapshot would serve replica rows to a
 * web request that just invalidated, or primary rows to a gateway request. A process
 * serves one app, so this holds one entry there.
 */
const cacheByClient = new Map<ModelStatsLoadClient, CacheState>();
let generation = 0;

function cacheFor(fromDb: ModelStatsLoadClient): CacheState {
  const existing = cacheByClient.get(fromDb);
  if (existing) return existing;
  const state: CacheState = { cached: null, inFlight: null, failure: null };
  cacheByClient.set(fromDb, state);
  return state;
}

export function isModelStatsSnapshotFresh(snapshot: ModelStatsCacheMetadata): boolean {
  const age = Date.now() - snapshot.observedAt;
  return snapshot.generation === generation && age >= 0 && age < CACHE_TTL_MS;
}

async function loadEntries(fromDb: ModelStatsLoadClient): Promise<ModelStatsCacheEntry[]> {
  if (!ENKRYPT_PUBLICATION_ENABLED) {
    const rows = await fromDb
      .select({ stat: modelStats })
      .from(modelStats)
      .orderBy(desc(modelStats.codingIndex));
    return rows.map(row => ({ ...row, verification: undefined }));
  }
  return fromDb
    .select({
      stat: modelStats,
      verification: sql<unknown>`${enkrypt_sync_state.verified_models} -> ${modelStats.openrouterId}`,
    })
    .from(modelStats)
    .leftJoin(enkrypt_sync_state, eq(enkrypt_sync_state.job_name, 'enkrypt'))
    .orderBy(desc(modelStats.codingIndex));
}

export async function getModelStatsSnapshot({
  fromDb = db,
}: { fromDb?: ModelStatsLoadClient } = {}): Promise<ModelStatsSnapshot> {
  const state = cacheFor(fromDb);
  if (state.cached && isModelStatsSnapshotFresh(state.cached)) return state.cached;
  if (state.inFlight) return state.inFlight;
  if (state.failure && Date.now() < state.failure.retryAt) {
    if (state.cached) return state.cached;
    throw state.failure.error;
  }
  const startGeneration = generation;
  const observedAt = Date.now();
  const thisLoad = (async () => {
    try {
      const [entries, customLlmsById] = await Promise.all([
        loadEntries(fromDb),
        requireCustomLlmsById(),
      ]);
      const snapshot = {
        entries,
        observedAt,
        generation: startGeneration,
        customLlmIds: new Set(customLlmsById.keys()),
      };
      if (generation === startGeneration) {
        state.cached = snapshot;
        state.failure = null;
      }
      return snapshot;
    } catch (error) {
      if (generation === startGeneration) {
        state.failure = { retryAt: Date.now() + FAILURE_RETRY_MS, error };
      }
      if (state.cached) return state.cached;
      throw error;
    }
  })().finally(() => {
    if (state.inFlight === thisLoad) state.inFlight = null;
  });
  state.inFlight = thisLoad;
  return thisLoad;
}

export function invalidateModelStatsCache(): void {
  generation++;
  for (const state of cacheByClient.values()) {
    state.inFlight = null;
    state.failure = null;
  }
}
