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

// Single source of truth for each metadata record; derived views below
// key off the returned object identity to avoid recomputation.
export const getVercelModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.vercelModels,
  'Vercel'
);

export const getOpenRouterModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.openrouterModels,
  'OpenRouter'
);

const languageModelIdSetCache = new WeakMap<StoredModelMap, ReadonlySet<string>>();

function toLanguageModelIdSet(models: StoredModelMap): ReadonlySet<string> {
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

export async function getVercelModels(): Promise<ReadonlySet<string>> {
  return toLanguageModelIdSet(await getVercelModelsMetadata());
}

export async function getOpenRouterModels(): Promise<ReadonlySet<string>> {
  return toLanguageModelIdSet(await getOpenRouterModelsMetadata());
}
