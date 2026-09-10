import { modelsByProvider, StoredModelSchema, type StoredModel } from '@kilocode/db';
import { desc } from 'drizzle-orm';
import * as z from 'zod';
import { createCachedFetch } from '@/lib/cached-fetch';
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

/** The ids of language models, including those with no endpoints. */
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

const vercelInferenceProviderFetchers = new Map<string, () => Promise<string[] | null>>();

export function getCachedVercelInferenceProviderIdsForModel(
  modelId: string
): Promise<string[] | null> {
  let fetchProviders = vercelInferenceProviderFetchers.get(modelId);
  if (!fetchProviders) {
    fetchProviders = createCachedFetch<string[] | null>(
      async () => {
        const models = await getVercelModelsMetadataFromDatabase();
        const model = models[modelId];
        return model ? extractVercelInferenceProviderIdsFromModel(model) : null;
      },
      TTL_MS,
      null
    );
    vercelInferenceProviderFetchers.set(modelId, fetchProviders);
  }

  return fetchProviders();
}

function createLanguageModelIdsFetcher(fetchModels: () => Promise<StoredModelMap>) {
  return createCachedFetch<ReadonlySet<string>>(
    async () => new Set(getLanguageModelIds(await fetchModels())),
    TTL_MS,
    new Set<string>()
  );
}

export const getVercelModelsFromDatabase = createLanguageModelIdsFetcher(
  getVercelModelsMetadataFromDatabase
);

export const getOpenRouterModelsFromDatabase = createLanguageModelIdsFetcher(
  getOpenRouterModelsMetadataFromDatabase
);

// Undocumented aliases that remain in active use but are absent from OpenRouter's model catalog.
const legacyOpenRouterAliases: ReadonlySet<string> = new Set([
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-sonnet-5-20260630',
  'claude-opus-5',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-5',
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
  'deepseek-v4-pro',
  'gemini-2.5-flash-lite',
  'glm-5.1',
  'glm-5.2',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'kimi-k3',
  'mimo-v2.5',
  'minimax-m2.5',
  'minimax-m3',
  'minimax/minimax-m2.5-20260211',
  'openai/gpt-4o-mini-transcribe',
  'openai/gpt-4o-transcribe',
  'step-3.5-flash',
]);

export async function isValidOpenRouterModelId(modelId: string): Promise<boolean> {
  if (legacyOpenRouterAliases.has(modelId)) {
    return true;
  }
  const openRouterModelIds = await getOpenRouterModelsFromDatabase();
  if (openRouterModelIds.size === 0) {
    warnExceptInTest(
      '[isValidOpenRouterModelId] no model metadata available, assuming id is valid'
    );
    return true;
  }
  return openRouterModelIds.has(modelId);
}
