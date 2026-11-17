import type { Endpoint } from '@kilocode/db/schema-types';
import type {
  GatewayModelMap,
  GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  getModelDisplayPricing,
  maxEndpointPricing,
  type EndpointPricing,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import {
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';

/** Whether a Vercel endpoint is served by the provider of an OpenRouter endpoint tag or slug. */
export function isVercelEndpointOfProvider(vercelEndpoint: Endpoint, openRouterProvider: string) {
  return (
    normalizeVercelInferenceProviderIdForRouting(
      vercelEndpoint.provider_name ?? vercelEndpoint.tag
    ) === openRouterToVercelInferenceProviderId(openRouterProvider)
  );
}

/**
 * The default price of the provider `openRouterProvider` (an OpenRouter endpoint tag or provider
 * slug): the higher of OpenRouter's `pricing` and the prices of Vercel's endpoints for that
 * provider. Custom pricing does not apply to a single provider's price.
 */
export function getProviderDisplayPricing(
  openRouterProvider: string | undefined,
  pricing: EndpointPricing | undefined,
  vercelModel: Pick<GatewayModelWithEndpoints, 'endpoints'> | undefined
): EndpointPricing | undefined {
  const displayPricing = getModelDisplayPricing(pricing);
  if (!displayPricing || !openRouterProvider || !vercelModel) return displayPricing;
  return vercelModel.endpoints.reduce((max, vercelEndpoint) => {
    const vercelPricing = getModelDisplayPricing(vercelEndpoint.pricing);
    return vercelPricing && isVercelEndpointOfProvider(vercelEndpoint, openRouterProvider)
      ? maxEndpointPricing(max, vercelPricing)
      : max;
  }, displayPricing);
}

export type VercelPricingMetadata = {
  models: GatewayModelMap;
  overrides: VercelModelIdOverrides;
};

export const EMPTY_VERCEL_PRICING_METADATA: VercelPricingMetadata = {
  models: {},
  overrides: new Map(),
};

export async function getVercelPricingMetadata(): Promise<VercelPricingMetadata> {
  const [models, overrides] = await Promise.all([
    getVercelModelsMetadataFromDatabase(),
    getVercelModelIdOverrides(),
  ]);
  return { models, overrides };
}

/**
 * The Vercel model whose endpoint prices count for the resolved model id. Kilo charges nothing for
 * a free model, whatever Vercel charges for its paid sibling.
 */
export function getVercelModelForPricing(
  vercel: VercelPricingMetadata,
  resolvedModelId: string
): GatewayModelWithEndpoints | undefined {
  if (isFreeModel(resolvedModelId)) return undefined;
  const vercelModelId = mapResolvedModelIdToVercel(resolvedModelId, vercel.overrides);
  return Object.hasOwn(vercel.models, vercelModelId) ? vercel.models[vercelModelId] : undefined;
}
