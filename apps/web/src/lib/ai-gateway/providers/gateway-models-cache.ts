import { StoredModelSchema, type StoredModel } from '@kilocode/db';
import * as z from 'zod';
import { redisGet } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GATEWAY_METADATA_REDIS_KEYS } from '@/lib/redis-keys';
import type { RedisKey } from '@/lib/redis-keys';

export type StoredModelMap = Record<string, StoredModel>;

const StoredModelMapSchema = z.record(z.string(), StoredModelSchema);

function createStoredModelsFetcher(redisKey: RedisKey, name: string) {
  return createCachedFetch<StoredModelMap>(
    async () => {
      const raw = JSON.parse((await redisGet(redisKey)) ?? 'null');
      if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
        console.debug(`[getGatewayModels] no ${name} models found in Redis`);
        return {};
      }
      return StoredModelMapSchema.parse(raw);
    },
    600_000,
    {}
  );
}

export const getVercelModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.vercelModels,
  'Vercel'
);

export const getOpenRouterModelsMetadata = createStoredModelsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.openrouterModels,
  'OpenRouter'
);

function toLanguageModelIdSet(models: StoredModelMap): ReadonlySet<string> {
  return new Set(
    Object.values(models)
      .filter(model => (model.type ?? 'language') === 'language' && model.endpoints.length > 0)
      .map(model => model.id)
  );
}

export async function getVercelModels(): Promise<ReadonlySet<string>> {
  return toLanguageModelIdSet(await getVercelModelsMetadata());
}

export async function getOpenRouterModels(): Promise<ReadonlySet<string>> {
  return toLanguageModelIdSet(await getOpenRouterModelsMetadata());
}
