import { StoredModelSchema, type StoredModel } from '@kilocode/db';
import * as z from 'zod';
import { redisGet } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';
import type { RedisKey } from '@/lib/redis-keys';

export type StoredModelMap = Record<string, StoredModel>;

const EMPTY_STORED_MODELS: StoredModelMap = Object.freeze({}) as StoredModelMap;

const StoredModelMapSchema = z.record(z.string(), StoredModelSchema);

function createStoredModelsFetcher(redisKey: RedisKey, name: string) {
  return createCachedFetch<StoredModelMap>(
    async () => {
      const raw = JSON.parse((await redisGet(redisKey)) ?? 'null');
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
        console.debug(`[getGatewayModels] no ${name} models found in Redis`);
        return EMPTY_STORED_MODELS;
      }
      return StoredModelMapSchema.parse(raw);
    },
    600_000,
    EMPTY_STORED_MODELS
  );
}

/**
 * Cached fetcher for the full Vercel model metadata record. This is the
 * single source of truth for Vercel model metadata in-process; all other
 * Vercel-model views derive from it to avoid duplicate Redis reads.
 */
export const getVercelModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.vercelModels,
  'Vercel'
);

/** Cached fetcher for the full OpenRouter model metadata record. */
export const getOpenRouterModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.openrouterModels,
  'OpenRouter'
);

// Memoize the derived Set on the identity of the metadata object. The
// metadata fetcher returns the same object reference until the 10-minute
// cache refreshes, so this avoids re-filtering hundreds of models on
// every gateway request while still invalidating automatically whenever
// the underlying record changes.
const languageModelIdSetCache = new WeakMap<StoredModelMap, Set<string>>();

function toLanguageModelIdSet(models: StoredModelMap): Set<string> {
  const cached = languageModelIdSetCache.get(models);
  if (cached) return cached;
  const set = new Set(
    Object.values(models)
      .filter(model => (model.type ?? 'language') === 'language' && model.endpoints.length > 0)
      .map(model => model.id)
  );
  languageModelIdSetCache.set(models, set);
  return set;
}

export async function getVercelModels(): Promise<Set<string>> {
  return toLanguageModelIdSet(await getVercelModelsMetadata());
}

export async function getOpenRouterModels(): Promise<Set<string>> {
  return toLanguageModelIdSet(await getOpenRouterModelsMetadata());
}
