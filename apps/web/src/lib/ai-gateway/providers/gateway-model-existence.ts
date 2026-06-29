import type { StoredModel } from '@kilocode/db/schema-types';
import { redisClient } from '@/lib/redis';
import {
  gatewayModelExistsRedisKey,
  type GatewayModelExistenceProvider,
  type RedisKey,
} from '@/lib/redis-keys';

/**
 * Per-model "model exists at gateway" markers.
 *
 * The routing hot path only needs a yes/no answer to "is this model available at
 * gateway X?". Loading the entire model catalog blob from Redis (and zod-parsing
 * a few hundred models) just to build a membership Set is wasteful, so provider
 * sync instead writes one tiny marker key per routable model and the hot path
 * reads a single key.
 *
 * Expiry strategy: provider sync runs every 10 minutes and re-writes every
 * marker, but it occasionally fails, so we cannot assume markers are refreshed on
 * schedule. The markers therefore carry a TTL that is several sync cycles long:
 *
 *  - A handful of consecutive sync failures will NOT expire still-valid markers.
 *  - A model removed from a gateway's catalog stops being refreshed and its
 *    marker eventually expires on its own, since sync never deletes markers.
 *
 * If markers do go stale (prolonged sync outage) every marker expires and
 * existence checks return `false`, which is the safe direction for both current
 * callers: Vercel routing falls back to OpenRouter, and auto-free routing simply
 * drops the affected candidates.
 */
export const GATEWAY_MODEL_EXISTENCE_TTL_SECONDS = 60 * 60; // 1 hour ~= 6 sync cycles

const EXISTS_MARKER = '1';

/**
 * Short in-process cache so the hot path does not issue a Redis round trip on
 * every request. This only caches the resolved boolean (pure data); the
 * authoritative expiry lives on the Redis keys themselves.
 */
const RESULT_CACHE_TTL_MS = 60_000;

const resultCache = new Map<RedisKey, { value: boolean; at: number }>();

function isRoutableLanguageModel(model: StoredModel): boolean {
  return (model.type ?? 'language') === 'language' && model.endpoints.length > 0;
}

/** The routable language-model ids that get an existence marker on sync. */
export function routableLanguageModelIds(models: Record<string, StoredModel>): string[] {
  return Object.values(models)
    .filter(isRoutableLanguageModel)
    .map(model => model.id);
}

/**
 * Write (or refresh) the existence markers for every routable language model of
 * a gateway. Called from provider sync after the catalog blob has been mirrored.
 */
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

/**
 * Whether `modelId` currently has an existence marker for `provider`.
 *
 * Reads a single Redis key (cached briefly in-process). Fails open to the
 * last-known value, or `false` when nothing has been cached yet, so a Redis blip
 * never blocks the routing hot path.
 */
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
    resultCache.set(key, { value, at: now });
    return value;
  } catch {
    return cached?.value ?? false;
  }
}
