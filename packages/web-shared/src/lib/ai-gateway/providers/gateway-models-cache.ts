import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { MetadataSource } from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  formatModelIds,
  joinGatewayModelEndpoints,
  openRouterGatewayModelsSource,
  readStoredGatewayModels,
  vercelGatewayModelsSource,
  type GatewayModelList,
  type GatewayModelMap,
  type GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { legacyOpenRouterAliases } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

const TTL_MS = 300_000;

/**
 * Unlike sync-providers, the request path never fetches upstream: a listed model whose endpoints
 * are not stored yet is left out until the refresh job stores them. A list or joined catalog that
 * looks truncated throws, so callers keep the last good map.
 */
function createGatewayModelsFetcher(
  gateway: Provider,
  source: MetadataSource<GatewayModelList>,
  name: string
) {
  return createCachedFetch<GatewayModelMap>(
    async () => {
      const stored = await readStoredGatewayModels(gateway, source, readDb);
      if (!stored) {
        console.debug(`[getGatewayModels] no ${name} models found in the database`);
        return {};
      }
      const { models, withoutStoredEndpoints } = joinGatewayModelEndpoints(
        gateway,
        stored.models,
        stored.endpoints
      );
      if (withoutStoredEndpoints.length > 0) {
        warnExceptInTest(
          `[getGatewayModels] left out ${withoutStoredEndpoints.length} ${name} models without stored endpoints: ${formatModelIds(withoutStoredEndpoints)}`
        );
      }
      return models;
    },
    TTL_MS,
    {},
    { name: `gatewayModels[${gateway.type}]` }
  );
}

export const getVercelModelsMetadataFromDatabase = createGatewayModelsFetcher(
  VERCEL_AI_GATEWAY,
  vercelGatewayModelsSource,
  'Vercel'
);

export const getOpenRouterModelsMetadataFromDatabase = createGatewayModelsFetcher(
  OPENROUTER,
  openRouterGatewayModelsSource,
  'OpenRouter'
);

export async function resolveOpenRouterModelAlias(modelId: string): Promise<string> {
  if (!modelId.startsWith('~')) {
    return modelId;
  }

  const models = await getOpenRouterModelsMetadataFromDatabase();
  return models[modelId]?.alias_target?.slug ?? modelId;
}

/**
 * The ids of language models, including those with no endpoints. Vercel models
 * carry a `type`; OpenRouter models are language models when they output text.
 */
export function getLanguageModelIds(models: GatewayModelMap): string[] {
  return Object.values(models)
    .filter(
      model => model.type === 'language' || model.architecture?.output_modalities.includes('text')
    )
    .map(model => model.id);
}

/**
 * The ids of System One models, including `:free` variants and `~` aliases.
 * Vercel types them as `evaluation`; OpenRouter models output `decisions`.
 */
export function getSystemOneModelIds(models: GatewayModelMap): string[] {
  return Object.values(models)
    .filter(
      model =>
        model.type === 'evaluation' || model.architecture?.output_modalities.includes('decisions')
    )
    .map(model => model.id);
}

export function extractVercelInferenceProviderIdsFromModel(
  model: GatewayModelWithEndpoints
): string[] {
  return [
    ...new Set(
      model.endpoints.map(endpoint => endpoint.provider_name).filter(p => p !== undefined)
    ),
  ];
}

/**
 * Inference provider ids per model id, projected from the cached Vercel metadata map. Nothing is
 * keyed by the queried id, so the retained set is bounded by the catalog rather than by lookups.
 */
const getVercelInferenceProviderIdsByModel = createCachedFetch<ReadonlyMap<string, string[]>>(
  async () => {
    const models = await getVercelModelsMetadataFromDatabase();
    return new Map(
      Object.entries(models).map(([modelId, model]) => [
        modelId,
        extractVercelInferenceProviderIdsFromModel(model),
      ])
    );
  },
  TTL_MS,
  new Map(),
  { name: 'vercelInferenceProviderIdsByModel' }
);

export async function getCachedVercelInferenceProviderIdsForModel(
  modelId: string
): Promise<string[] | null> {
  return (await getVercelInferenceProviderIdsByModel()).get(modelId) ?? null;
}

function createLanguageModelIdsFetcher(name: string, fetchModels: () => Promise<GatewayModelMap>) {
  return createCachedFetch<ReadonlySet<string>>(
    async () => new Set(getLanguageModelIds(await fetchModels())),
    TTL_MS,
    new Set<string>(),
    { name }
  );
}

export const getVercelModelsFromDatabase = createLanguageModelIdsFetcher(
  'vercelLanguageModelIds',
  getVercelModelsMetadataFromDatabase
);

export const getOpenRouterModelsFromDatabase = createLanguageModelIdsFetcher(
  'openRouterLanguageModelIds',
  getOpenRouterModelsMetadataFromDatabase
);

export const getOpenRouterSystemOneModelsFromDatabase = createCachedFetch<ReadonlySet<string>>(
  async () => new Set(getSystemOneModelIds(await getOpenRouterModelsMetadataFromDatabase())),
  TTL_MS,
  new Set<string>(),
  { name: 'openRouterSystemOneModelIds' }
);

// The cached empty id set is the same instance for a whole TTL window, so warning once per distinct
// empty snapshot reports an outage once per window instead of once per validated model id.
let warnedMissingOpenRouterModelMetadataFor: ReadonlySet<string> | null = null;

export async function isValidOpenRouterModelId(modelId: string): Promise<boolean> {
  if (legacyOpenRouterAliases.has(modelId)) {
    return true;
  }
  const openRouterModelIds = await getOpenRouterModelsFromDatabase();
  if (openRouterModelIds.size === 0) {
    if (warnedMissingOpenRouterModelMetadataFor !== openRouterModelIds) {
      warnedMissingOpenRouterModelMetadataFor = openRouterModelIds;
      warnExceptInTest(
        '[isValidOpenRouterModelId] no model metadata available, assuming id is valid'
      );
    }
    return true;
  }
  warnedMissingOpenRouterModelMetadataFor = null;
  return openRouterModelIds.has(modelId);
}
