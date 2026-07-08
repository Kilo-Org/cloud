import { modelsByProvider, StoredModelSchema, type StoredModel } from '@kilocode/db';
import { desc } from 'drizzle-orm';
import * as z from 'zod';
import { redisClient } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GATEWAY_METADATA_REDIS_KEYS, vercelInferenceProvidersRedisKey } from '@/lib/redis-keys';
import type { RedisKey } from '@/lib/redis-keys';
import { readDb } from '@/lib/drizzle';

export type StoredModelMap = Record<string, StoredModel>;

const StoredModelMapSchema = z.record(z.string(), StoredModelSchema);

function createStoredModelsFromDatabaseFetcher(provider: 'openrouter' | 'vercel', name: string) {
  return createCachedFetch<StoredModelMap>(
    async () => {
      const [row] = await readDb
        .select({ models: modelsByProvider[provider] })
        .from(modelsByProvider)
        .orderBy(desc(modelsByProvider.id))
        .limit(1);
      if (!row?.models || Object.keys(row.models).length === 0) {
        console.debug(`[getGatewayModels] no ${name} models found in the database`);
        return {};
      }
      return StoredModelMapSchema.parse(row.models);
    },
    600_000,
    {}
  );
}

export const getVercelModelsMetadataFromDatabase = createStoredModelsFromDatabaseFetcher(
  'vercel',
  'Vercel'
);

export const getOpenRouterModelsMetadataFromDatabase = createStoredModelsFromDatabaseFetcher(
  'openrouter',
  'OpenRouter'
);

/**
 * The ids of language models that have at least one endpoint. This is the list
 * mirrored to the lightweight `*-model-ids` Redis keys so existence checks can
 * avoid loading the full model catalog.
 */
export function getLanguageModelIds(models: StoredModelMap): string[] {
  return Object.values(models)
    .filter(model => (model.type ?? 'language') === 'language' && model.endpoints.length > 0)
    .map(model => model.id);
}

export function extractVercelInferenceProviderIdsFromModel(model: StoredModel): string[] {
  return [
    ...new Set(
      model.endpoints.map(endpoint => endpoint.provider_name).filter(p => p !== undefined)
    ),
  ];
}

const VercelInferenceProvidersSchema = z.array(z.string());
const vercelInferenceProviderFetchers = new Map<string, () => Promise<string[] | null>>();

export function getCachedVercelInferenceProviderIdsForModel(
  modelId: string
): Promise<string[] | null> {
  let fetchProviders = vercelInferenceProviderFetchers.get(modelId);
  if (!fetchProviders) {
    fetchProviders = createCachedFetch<string[] | null>(
      async () => {
        const raw = await redisClient.get<string>(vercelInferenceProvidersRedisKey(modelId));
        if (raw === null) {
          return null;
        }
        return VercelInferenceProvidersSchema.parse(JSON.parse(raw));
      },
      600_000,
      null
    );
    vercelInferenceProviderFetchers.set(modelId, fetchProviders);
  }

  return fetchProviders();
}

const ModelIdsSchema = z.array(z.string());

function createModelIdsFetcher(redisKey: RedisKey, name: string) {
  return createCachedFetch<ReadonlySet<string>>(
    async () => {
      const raw = JSON.parse((await redisClient.get<string>(redisKey)) ?? 'null');
      if (!Array.isArray(raw) || raw.length === 0) {
        console.debug(`[getGatewayModels] no ${name} model ids found in Redis`);
        return new Set<string>();
      }
      return new Set(ModelIdsSchema.parse(raw));
    },
    600_000,
    new Set<string>()
  );
}

export const getVercelModelsFromRedis = createModelIdsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.vercelModelIds,
  'Vercel'
);

export const getOpenRouterModelsFromRedis = createModelIdsFetcher(
  GATEWAY_METADATA_REDIS_KEYS.openrouterModelIds,
  'OpenRouter'
);
