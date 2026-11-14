import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import {
  extractVercelInferenceProviderIdsFromModel,
  getVercelModelsMetadataFromDatabase,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getVercelModelIdOverrides } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  findVercelOnlyModels,
  getVendorNamesByModelPrefix,
  getVercelOnlyModelName,
  type VercelOnlyModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/find-vercel-only-models';
import { getVercelInferenceProvidersExcludingIgnored } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

function toVercelOnlyCatalogModel(model: VercelOnlyModel, name: string): OpenRouterModel {
  const { id, storedModel, contextWindow, modalities, pricing } = model;
  // Without `opencode`, the catalog derives it with getGatewayOpenCodeSettings, which routing also
  // uses to resolve variants.
  return {
    id,
    name,
    created: storedModel.released ?? storedModel.created ?? 0,
    description: storedModel.description ?? '',
    architecture: {
      input_modalities: modalities.input,
      output_modalities: modalities.output,
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: contextWindow,
      max_completion_tokens: storedModel.max_tokens,
    },
    pricing: {
      prompt: pricing.input,
      completion: pricing.output,
      ...(pricing.input_cache_read && { input_cache_read: pricing.input_cache_read }),
      ...(pricing.input_cache_write && { input_cache_write: pricing.input_cache_write }),
    },
    context_length: contextWindow,
    supported_parameters: storedModel.supported_parameters,
    expiration_date: storedModel.deprecated_at
      ? new Date(storedModel.deprecated_at).toISOString().slice(0, 10)
      : undefined,
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
  openRouterMetadata: GatewayModelMap;
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
    openRouterModels,
    vercelMetadata,
    overrides,
  })
    .filter(model => !routingConfig.vercelOptOutModels.has(model.id) && hasRoutableProvider(model))
    .map(model => toVercelOnlyCatalogModel(model, getVercelOnlyModelName(model, vendorNames)))
    .sort((a, b) => b.created - a.created);
}
