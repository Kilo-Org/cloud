import type { StoredModel } from '@kilocode/db/schema-types';
import { redisClient } from '@/lib/redis';
import {
  gatewayModelExistsRedisKey,
  type GatewayModelExistenceProvider,
  type RedisKey,
} from '@/lib/redis-keys';

// Per-model "model exists at gateway" markers let the routing hot path answer
// "is this model available at gateway X?" with one tiny Redis read instead of
// loading and zod-parsing the whole catalog blob into a membership Set.
//
// Sync re-writes every marker (every ~10 min) but occasionally fails, so markers
// carry a TTL of several sync cycles: a few failed syncs won't expire valid
// markers, while a model removed from a gateway expires on its own since sync
// only writes markers, never deletes them. A full lapse resolves to "not found",
// the safe direction for both callers.
export const GATEWAY_MODEL_EXISTENCE_TTL_SECONDS = 60 * 60; // ~6 sync cycles

const EXISTS_MARKER = '1';

// Short in-process cache (pure booleans) so the hot path avoids a Redis round
// trip per request; the authoritative expiry lives on the Redis keys. Bounded
// because callers pass request-derived (and thus attacker-controlled) model ids;
// the oldest entry is evicted once the cap is reached so the Map can't grow for
// the lifetime of the isolate.
const RESULT_CACHE_TTL_MS = 60_000;
const RESULT_CACHE_MAX_ENTRIES = 2_000;

const resultCache = new Map<RedisKey, { value: boolean; at: number }>();

function cacheResult(key: RedisKey, value: boolean, at: number): void {
  // Re-insert so iteration order tracks recency, then drop the oldest if over cap.
  resultCache.delete(key);
  resultCache.set(key, { value, at });
  if (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
}

function isRoutableLanguageModel(model: StoredModel): boolean {
  return (model.type ?? 'language') === 'language' && model.endpoints.length > 0;
}

export function routableLanguageModelIds(models: Record<string, StoredModel>): string[] {
  return Object.values(models)
    .filter(isRoutableLanguageModel)
    .map(model => model.id);
}

export async function writeGatewayModelExistenceMarkers(
  provider: GatewayModelExistenceProvider,
  models: Record<string, StoredModel>
): Promise<void> {
  const ids = routableLanguageModelIds(models);
  if (ids.length === 0) return;

  const pipeline = redisClient.pipeline();
  for (const id of ids) {
    pipeline.set(gatewayModelExistsRedisKey(provider, id), EXISTS_MARKER, {
      ex: GATEWAY_MODEL_EXISTENCE_TTL_SECONDS,
    });
  }
  await pipeline.exec();
}

// Reads a single marker key (cached briefly in-process). Fails open to the
// last-known value, or `false` when cold, so a Redis blip never blocks routing.
export async function gatewayModelExists(
  provider: GatewayModelExistenceProvider,
  modelId: string
): Promise<boolean> {
  const key = gatewayModelExistsRedisKey(provider, modelId);
  const now = Date.now();

  const cached = resultCache.get(key);
  if (cached && now - cached.at < RESULT_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const value = (await redisClient.get<string>(key)) === EXISTS_MARKER;
    cacheResult(key, value, now);
    return value;
  } catch {
    return cached?.value ?? false;
  }
}
