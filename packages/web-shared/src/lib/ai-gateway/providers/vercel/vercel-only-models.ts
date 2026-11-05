import type { Endpoint, StoredModel } from '@kilocode/db/schema-types';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import {
  extractVercelInferenceProviderIdsFromModel,
  getVercelModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getOpenCodeSettingsForReasoningOptions,
  toReasoningOptions,
} from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
  mapVercelModelIdToOpenRouter,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProvidersExcludingIgnored } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

export type VercelOnlyModel = {
  /** The OpenRouter-style ID that routes to the Vercel model. */
  id: string;
  storedModel: StoredModel;
  inputModalities: string[];
  outputModalities: string[];
  /** The largest context of its endpoints. */
  contextLength: number;
  /** The first endpoint's prices; Vercel lists the provider it routes to by default first. */
  pricing: NonNullable<Endpoint['pricing']>;
};

/** The listing fields of a stored Vercel chat model, or null when they are incomplete. */
function describeChatModel(id: string, storedModel: StoredModel): VercelOnlyModel | null {
  const { architecture, endpoints } = storedModel;
  const pricing = endpoints[0]?.pricing;
  const contextLength = Math.max(0, ...endpoints.map(endpoint => endpoint.context_length ?? 0));
  if (
    storedModel.type !== 'language' ||
    !architecture?.output_modalities.includes('text') ||
    !pricing ||
    contextLength === 0
  ) {
    return null;
  }
  return {
    id,
    storedModel,
    inputModalities: architecture.input_modalities ?? ['text'],
    outputModalities: architecture.output_modalities,
    contextLength,
    pricing,
  };
}

/**
 * The Vercel chat models that no OpenRouter model routes to, under the
 * OpenRouter-style IDs that route back to them. Only models in the stored Vercel metadata count,
 * because routing checks that list.
 */
export function findVercelOnlyModels({
  openRouterModelIds,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  vercelMetadata: StoredModelMap;
  overrides: VercelModelIdOverrides;
}): VercelOnlyModel[] {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds].map(id => mapResolvedModelIdToVercel(id, overrides))
  );
  return Object.values(vercelMetadata).flatMap(storedModel => {
    if (coveredVercelModelIds.has(storedModel.id)) return [];
    const id = mapVercelModelIdToOpenRouter(storedModel.id, overrides);
    // The proxy lowercases requested model IDs before routing.
    if (!id || id !== id.toLowerCase()) return [];
    return describeChatModel(id, storedModel) ?? [];
  });
}

function getModelPrefix(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf('/');
  return slashIndex > 0 ? modelId.slice(0, slashIndex) : undefined;
}

/** OpenRouter names start with the vendor, as in `Qwen: Qwen3 Max`. */
export function getVendorNamesByModelPrefix(
  openRouterModels: Iterable<{ id: string; name: string }>
): ReadonlyMap<string | undefined, string> {
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

export function getVercelOnlyModelName(
  { id, storedModel }: VercelOnlyModel,
  vendorNames: ReadonlyMap<string | undefined, string>
): string {
  const vendorName = vendorNames.get(getModelPrefix(id));
  return vendorName ? `${vendorName}: ${storedModel.name}` : storedModel.name;
}

function toVercelOnlyCatalogModel(model: VercelOnlyModel, name: string): OpenRouterModel {
  const { id, storedModel, pricing, contextLength } = model;
  const reasoningOptions = toReasoningOptions(id, storedModel.reasoning);
  const supportedParameters = [
    ...new Set(storedModel.endpoints.flatMap(endpoint => endpoint.supported_parameters ?? [])),
  ];
  return {
    id,
    name,
    created: storedModel.released ?? storedModel.created ?? 0,
    description: storedModel.description ?? '',
    architecture: {
      input_modalities: model.inputModalities,
      output_modalities: model.outputModalities,
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: contextLength,
      max_completion_tokens: storedModel.endpoints[0]?.max_completion_tokens,
    },
    pricing: {
      prompt: pricing.prompt,
      completion: pricing.completion,
      ...(pricing.input_cache_read && { input_cache_read: pricing.input_cache_read }),
      ...(pricing.input_cache_write && { input_cache_write: pricing.input_cache_write }),
    },
    context_length: contextLength,
    supported_parameters: supportedParameters.length > 0 ? supportedParameters : undefined,
    opencode: reasoningOptions && getOpenCodeSettingsForReasoningOptions(id, reasoningOptions),
  };
}

/**
 * Whether a Vercel provider remains after the providers Kilo always excludes outside non-trial
 * enterprise organizations.
 */
function hasRoutableProvider({ id, storedModel }: VercelOnlyModel) {
  return (
    getVercelInferenceProvidersExcludingIgnored(
      getIgnoredProviders(id, false),
      undefined,
      extractVercelInferenceProviderIdsFromModel(storedModel)
    ).length > 0
  );
}

/**
 * Catalog entries for the chat models only Vercel AI Gateway serves, newest first. Empty when Kilo
 * does not route to Vercel.
 */
export async function getVercelOnlyCatalogModels({
  openRouterModels,
  openRouterMetadata,
}: {
  openRouterModels: readonly OpenRouterModel[];
  openRouterMetadata: StoredModelMap;
}): Promise<OpenRouterModel[]> {
  const [routingConfig, vercelMetadata, overrides] = await Promise.all([
    getRuntimeGatewayRoutingConfig(),
    getVercelModelsMetadataFromDatabase(),
    getVercelModelIdOverrides(),
  ]);
  if (!routingConfig.vercelEnabled) return [];

  const vendorNames = getVendorNamesByModelPrefix(openRouterModels);
  return findVercelOnlyModels({
    openRouterModelIds: [
      ...openRouterModels.map(model => model.id),
      ...Object.keys(openRouterMetadata),
    ],
    vercelMetadata,
    overrides,
  })
    .filter(model => !routingConfig.vercelOptOutModels.has(model.id) && hasRoutableProvider(model))
    .map(model => toVercelOnlyCatalogModel(model, getVercelOnlyModelName(model, vendorNames)))
    .sort((a, b) => b.created - a.created);
}
