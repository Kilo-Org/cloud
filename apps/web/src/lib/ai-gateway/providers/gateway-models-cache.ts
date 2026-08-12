import { modelsByProvider, StoredModelSchema, type StoredModel } from '@kilocode/db';
import { desc } from 'drizzle-orm';
import * as z from 'zod';
import { redisClient } from '@/lib/redis';
import { createCachedFetch } from '@/lib/cached-fetch';
import { GATEWAY_METADATA_REDIS_KEYS, vercelInferenceProvidersRedisKey } from '@/lib/redis-keys';
import type { RedisKey } from '@/lib/redis-keys';
import { readDb } from '@/lib/drizzle';
import { warnExceptInTest } from '@/lib/utils.server';

export type StoredModelMap = Record<string, StoredModel>;

const StoredModelMapSchema = z.record(z.string(), StoredModelSchema);

const TTL_MS = 300_000;

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
    TTL_MS,
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
 * The ids of language models, including those with no endpoints. This is the
 * list mirrored to the lightweight `*-model-ids` Redis keys so existence checks
 * can avoid loading the full model catalog.
 */
export function getLanguageModelIds(models: StoredModelMap): string[] {
  return Object.values(models)
    .filter(model => (model.type ?? 'language') === 'language')
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
      TTL_MS,
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
    TTL_MS,
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

// These are (undocumented?) aliases OpenRouter accepts and were in use around 2026-08-11
// Preferably do not add entries here, instead have the user use the documented id from the /models catalog
const legacyOpenRouterAliases: ReadonlySet<string> = new Set([
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-opus-4-6',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-5-20260630',
  'claude-fable-5',
  'claude-haiku-4.5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-5',
  'codex-auto-review',
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-3-pro-image',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
  'glm-4.7-flash',
  'glm-5.1',
  'glm-5.2',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-16k',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.2-pro',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-luna-pro',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-oss-20b',
  'gpt-oss-safeguard-20b',
  'hy3',
  'kimi-k2.6',
  'kimi-k3',
  'laguna-s-2.1',
  'laguna-xs-2.1',
  'mimo-v2.5',
  'minimax-m2.5',
  'minimax-m3',
  'minimax/minimax-m2.5-20260211',
  'o1-pro',
  'o3-pro',
  'openai/gpt-4o-mini-transcribe',
  'openai/gpt-4o-transcribe',
  'openai/gpt-5.3-chat',
  'qwen3.8-max',
  'step-3.5-flash',
]);

export async function isValidOpenRouterModelId(modelId: string): Promise<boolean> {
  if (legacyOpenRouterAliases.has(modelId)) {
    return true;
  }
  const openRouterModelIds = await getOpenRouterModelsFromRedis();
  if (openRouterModelIds.size === 0) {
    warnExceptInTest(
      '[isValidOpenRouterModelId] no model metadata available, assuming id is valid'
    );
    return true;
  }
  return openRouterModelIds.has(modelId);
}
