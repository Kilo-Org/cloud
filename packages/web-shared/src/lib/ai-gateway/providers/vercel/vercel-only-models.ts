import * as z from 'zod';
import type { StoredModel } from '@kilocode/db/schema-types';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { vercelToOpenRouterInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
  getVercelModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
  mapVercelModelIdToOpenRouter,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProvidersExcludingIgnored } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

const VERCEL_CATALOG_TIMEOUT_MS = 5_000;

const VercelCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().catch(''),
  created: z.number(),
  released: z.number().optional().catch(undefined),
  type: z.string(),
  context_window: z.number(),
  max_tokens: z.number().optional().catch(undefined),
  modalities: z.object({
    input: z.array(z.string()),
    output: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()).optional().catch(undefined),
  pricing: z.object({
    input: z.string(),
    output: z.string(),
    input_cache_read: z.string().optional().catch(undefined),
    input_cache_write: z.string().optional().catch(undefined),
  }),
  /** Milliseconds since the epoch. */
  deprecated_at: z
    .number()
    .int()
    .min(0)
    .max(Date.UTC(9999, 11, 31))
    .nullable()
    .optional()
    .catch(undefined),
});

type VercelCatalogModel = z.infer<typeof VercelCatalogModelSchema>;

const VercelCatalogResponseSchema = z.object({ data: z.array(z.unknown()) });

/** Vercel's chat models, keyed by Vercel model ID. Entries that do not parse are left out. */
async function fetchVercelChatCatalog(): Promise<ReadonlyMap<string, VercelCatalogModel>> {
  const response = await fetch(`${VERCEL_AI_GATEWAY.apiUrl}/models`, {
    method: 'GET',
    headers: {
      ...ATTRIBUTION_HEADERS,
      authorization: `Bearer ${VERCEL_AI_GATEWAY.apiKey}`,
    },
    signal: AbortSignal.timeout(VERCEL_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Fetching Vercel AI Gateway models failed: ${response.status}`);
  }
  const { data } = VercelCatalogResponseSchema.parse(await response.json());
  return new Map(
    data.flatMap(entry => {
      const parsed = VercelCatalogModelSchema.safeParse(entry);
      return parsed.success &&
        parsed.data.type === 'language' &&
        parsed.data.modalities.output.includes('text')
        ? [[parsed.data.id, parsed.data] as const]
        : [];
    })
  );
}

const getVercelChatCatalog = createCachedFetch<ReadonlyMap<string, VercelCatalogModel>>(
  fetchVercelChatCatalog,
  300_000,
  new Map(),
  { name: 'vercelChatCatalog' }
);

/**
 * The Vercel language models that no OpenRouter or Kilo-exclusive model routes to, keyed by the
 * OpenRouter-style ID that routes back to them. Only models in the stored Vercel metadata count,
 * because routing checks that list.
 */
export function findVercelOnlyModelIds({
  openRouterModelIds,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  vercelMetadata: StoredModelMap;
  overrides: VercelModelIdOverrides;
}): Map<string, string> {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds, ...kiloExclusiveModels.map(model => model.public_id)].map(id =>
      mapResolvedModelIdToVercel(id, overrides)
    )
  );
  const vercelOnlyModelIds = new Map<string, string>();
  for (const vercelModelId of getLanguageModelIds(vercelMetadata)) {
    if (coveredVercelModelIds.has(vercelModelId)) continue;
    const modelId = mapVercelModelIdToOpenRouter(vercelModelId, overrides);
    // The proxy lowercases requested model IDs before routing.
    if (modelId && modelId === modelId.toLowerCase()) {
      vercelOnlyModelIds.set(modelId, vercelModelId);
    }
  }
  return vercelOnlyModelIds;
}

function getModelPrefix(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf('/');
  return slashIndex > 0 ? modelId.slice(0, slashIndex) : undefined;
}

/** OpenRouter names start with the vendor, as in `Qwen: Qwen3 Max`. */
function getVendorNamesByModelPrefix(openRouterModels: readonly OpenRouterModel[]) {
  const vendorNames = new Map<string | undefined, string>();
  for (const { id, name } of openRouterModels) {
    const prefix = getModelPrefix(id);
    const separatorIndex = name.indexOf(': ');
    if (prefix && separatorIndex > 0 && !vendorNames.has(prefix)) {
      vendorNames.set(prefix, name.slice(0, separatorIndex));
    }
  }
  return vendorNames;
}

function toVercelOnlyCatalogModel(
  modelId: string,
  vercelModel: VercelCatalogModel,
  storedModel: StoredModel,
  vendorName: string | undefined
): OpenRouterModel {
  const { pricing } = vercelModel;
  return {
    id: modelId,
    name: vendorName ? `${vendorName}: ${vercelModel.name}` : vercelModel.name,
    // Vercel's `created` is when Vercel added the model, often a shared backfill date.
    created: vercelModel.released ?? vercelModel.created,
    description: vercelModel.description,
    architecture: {
      input_modalities: vercelModel.modalities.input,
      output_modalities: vercelModel.modalities.output,
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: vercelModel.context_window,
      max_completion_tokens: vercelModel.max_tokens,
    },
    pricing: {
      prompt: pricing.input,
      completion: pricing.output,
      ...(pricing.input_cache_read && { input_cache_read: pricing.input_cache_read }),
      ...(pricing.input_cache_write && { input_cache_write: pricing.input_cache_write }),
    },
    context_length: vercelModel.context_window,
    supported_parameters: vercelModel.supported_parameters,
    expiration_date: vercelModel.deprecated_at
      ? new Date(vercelModel.deprecated_at).toISOString().slice(0, 10)
      : undefined,
    // As for OpenRouter models, a model whose every route trains on prompts requires data collection.
    mayTrainOnYourPrompts: !storedModel.endpoints.some(endpoint => endpoint.has_no_training),
  };
}

/**
 * Kilo picks its free models, and Vercel's zero-priced models would bypass free-model handling.
 */
function isZeroPriced({ pricing }: VercelCatalogModel) {
  return Number(pricing.input) === 0 && Number(pricing.output) === 0;
}

/**
 * Whether a Vercel provider remains after the providers Kilo always excludes outside non-trial
 * enterprise organizations, which cannot use Vercel-only models anyway: their model policy only
 * admits models in the provider snapshot.
 */
function hasRoutableProvider(modelId: string, storedModel: StoredModel) {
  return (
    getVercelInferenceProvidersExcludingIgnored(
      getIgnoredProviders(modelId, false),
      undefined,
      extractVercelInferenceProviderIdsFromModel(storedModel)
    ).length > 0
  );
}

export type VercelOnlyCatalogModel = {
  model: OpenRouterModel;
  /** OpenRouter provider slugs of the Vercel endpoints. */
  inferenceProviderIds: string[];
};

/**
 * Catalog entries for the chat models only Vercel AI Gateway serves, listed under the
 * OpenRouter-style IDs that route to them, newest first. Empty when Kilo does not route to Vercel.
 */
export async function getVercelOnlyCatalogModels({
  openRouterModels,
  openRouterMetadata,
}: {
  openRouterModels: readonly OpenRouterModel[];
  openRouterMetadata: StoredModelMap;
}): Promise<VercelOnlyCatalogModel[]> {
  const [routingConfig, vercelMetadata, overrides] = await Promise.all([
    getRuntimeGatewayRoutingConfig(),
    getVercelModelsMetadataFromDatabase(),
    getVercelModelIdOverrides(),
  ]);
  if (!routingConfig.vercelEnabled) return [];

  const candidates = [
    ...findVercelOnlyModelIds({
      openRouterModelIds: [
        ...openRouterModels.map(model => model.id),
        ...Object.keys(openRouterMetadata),
      ],
      vercelMetadata,
      overrides,
    }),
  ].flatMap(([modelId, vercelModelId]) => {
    const storedModel = vercelMetadata[vercelModelId];
    return storedModel &&
      !routingConfig.vercelOptOutModels.has(modelId) &&
      hasRoutableProvider(modelId, storedModel)
      ? [{ modelId, vercelModelId, storedModel }]
      : [];
  });
  if (candidates.length === 0) return [];

  const vercelChatCatalog = await getVercelChatCatalog();
  const vendorNames = getVendorNamesByModelPrefix(openRouterModels);
  return candidates
    .flatMap(({ modelId, vercelModelId, storedModel }) => {
      const vercelModel = vercelChatCatalog.get(vercelModelId);
      if (!vercelModel || isZeroPriced(vercelModel)) return [];
      return [
        {
          model: toVercelOnlyCatalogModel(
            modelId,
            vercelModel,
            storedModel,
            vendorNames.get(getModelPrefix(modelId))
          ),
          inferenceProviderIds: [
            ...new Set(
              extractVercelInferenceProviderIdsFromModel(storedModel).map(
                vercelToOpenRouterInferenceProviderId
              )
            ),
          ],
        },
      ];
    })
    .sort((a, b) => b.model.created - a.model.created);
}
