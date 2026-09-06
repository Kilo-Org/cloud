import 'server-only';

import { ENKRYPT_PUBLICATION_ENABLED } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { enkrypt_sync_state, modelStats, type ModelStats } from '@kilocode/db/schema';
import { desc, eq, sql } from 'drizzle-orm';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 1000;

export type ModelStatsCacheEntry = Readonly<{ stat: ModelStats; verification: unknown }>;
export type ModelStatsCacheMetadata = Readonly<{ observedAt: number; generation: number }>;
export type ModelStatsSnapshot = ModelStatsCacheMetadata & {
  readonly entries: readonly ModelStatsCacheEntry[];
};

let cached: ModelStatsSnapshot | null = null;
let inFlight: Promise<ModelStatsSnapshot> | null = null;
let generation = 0;
let failure: { retryAt: number; error: unknown } | null = null;

export function isModelStatsSnapshotFresh(snapshot: ModelStatsCacheMetadata): boolean {
  const age = Date.now() - snapshot.observedAt;
  return snapshot.generation === generation && age >= 0 && age < CACHE_TTL_MS;
}

async function loadEntries(): Promise<ModelStatsCacheEntry[]> {
  if (!ENKRYPT_PUBLICATION_ENABLED) {
    const rows = await db
      .select({ stat: modelStats })
      .from(modelStats)
      .orderBy(desc(modelStats.codingIndex));
    return rows.map(row => ({ ...row, verification: undefined }));
  }
  return db
    .select({
      stat: modelStats,
      verification: sql<unknown>`${enkrypt_sync_state.verified_models} -> ${modelStats.openrouterId}`,
    })
    .from(modelStats)
    .leftJoin(enkrypt_sync_state, eq(enkrypt_sync_state.job_name, 'enkrypt'))
    .orderBy(desc(modelStats.codingIndex));
}

export async function getModelStatsSnapshot(): Promise<ModelStatsSnapshot> {
  if (cached && isModelStatsSnapshotFresh(cached)) return cached;
  if (inFlight) return inFlight;
  if (failure && Date.now() < failure.retryAt) {
    if (cached) return cached;
    throw failure.error;
  }
  const startGeneration = generation;
  const observedAt = Date.now();
  const thisLoad = (async () => {
    try {
      const entries = await loadEntries();
      const snapshot = { entries, observedAt, generation: startGeneration };
      if (generation === startGeneration) {
        cached = snapshot;
        failure = null;
      }
      return snapshot;
    } catch (error) {
      if (generation === startGeneration) {
        failure = { retryAt: Date.now() + FAILURE_RETRY_MS, error };
      }
      if (cached) return cached;
      throw error;
    }
  })().finally(() => {
    if (inFlight === thisLoad) inFlight = null;
  });
  inFlight = thisLoad;
  return thisLoad;
}

export function invalidateModelStatsCache(): void {
  generation++;
  inFlight = null;
  failure = null;
}
