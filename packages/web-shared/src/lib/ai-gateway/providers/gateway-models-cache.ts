import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  formatModelIds,
  getOpenRouterAliasTarget,
  joinGatewayModelEndpoints,
  openRouterGatewayModelsSource,
  readStoredGatewayModels,
  retainPreviousEntries,
  vercelGatewayModelsSource,
  type GatewayModelsSource,
  type GatewayModelMap,
  type GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { legacyOpenRouterAliases } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

const TTL_MS = 300_000;

/**
 * Unlike sync-providers, the request path never fetches upstream: a listed model whose endpoints
 * are not stored yet keeps its previous entry, or is left out until the refresh job stores them. A
 * list or joined catalog that looks truncated throws, so callers keep the last good map.
 */
function createGatewayModelsFetcher(gateway: Provider, source: GatewayModelsSource, name: string) {
  let previous: GatewayModelMap = {};
  return createCachedFetch<GatewayModelMap>(
    async () => {
      const stored = await readStoredGatewayModels(gateway, source, readDb);
      if (!stored) {
        console.debug(`[getGatewayModels] no ${name} models found in the database`);
        return {};
      }
      const joined = joinGatewayModelEndpoints(gateway, stored);
      if (joined.withoutStoredEndpoints.length > 0) {
        warnExceptInTest(
          `[getGatewayModels] ${joined.withoutStoredEndpoints.length} ${name} models have no usable stored endpoints: ${formatModelIds(joined.withoutStoredEndpoints)}`
        );
      }
      previous = retainPreviousEntries(joined, previous);
      return previous;
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
  return getOpenRouterAliasTarget(models, modelId) ?? modelId;
}

/** The ids of Vercel language models, including those with no endpoints. */
export function getVercelLanguageModelIds(models: GatewayModelMap): string[] {
  return Object.values(models)
    .filter(model => model.type === 'language')
    .map(model => model.id);
}

/**
 * The ids of models OpenRouter serves on its chat APIs, including those with no endpoints: models
 * that output text or images. Vercel rejects image models on its chat APIs, so this is
 * OpenRouter-only.
 */
export function getOpenRouterChatModelIds(models: GatewayModelMap): string[] {
  return Object.values(models)
    .filter(model =>
      model.architecture?.output_modalities.some(
        modality => modality === 'text' || modality === 'image'
      )
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

function createModelIdsFetcher(
  name: string,
  fetchModels: () => Promise<GatewayModelMap>,
  selectModelIds: (models: GatewayModelMap) => string[]
) {
  return createCachedFetch<ReadonlySet<string>>(
    async () => new Set(selectModelIds(await fetchModels())),
    TTL_MS,
    new Set<string>(),
    { name }
  );
}

export const getVercelModelsFromDatabase = createModelIdsFetcher(
  'vercelLanguageModelIds',
  getVercelModelsMetadataFromDatabase,
  getVercelLanguageModelIds
);

export const getOpenRouterModelsFromDatabase = createModelIdsFetcher(
  'openRouterChatModelIds',
  getOpenRouterModelsMetadataFromDatabase,
  getOpenRouterChatModelIds
);

export const getOpenRouterSystemOneModelsFromDatabase = createModelIdsFetcher(
  'openRouterSystemOneModelIds',
  getOpenRouterModelsMetadataFromDatabase,
  getSystemOneModelIds
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
