import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getOpenRouterAliasTarget } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  getProviderDisplayPricing,
  getVercelModelForPricing,
  getVercelPricingMetadata,
  isVercelEndpointOfProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-endpoint-pricing';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import { isVercelRoutingOptOut } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { isUnavailableModel } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import type { Endpoint } from '@kilocode/db/schema-types';

const CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60';

export async function handleModelEndpointsRequest(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string; model: string }> }
) {
  const { provider, model } = await params;
  const modelId = `${provider}/${model}`;
  if (await isUnavailableModel(modelId)) {
    return NextResponse.json(
      { error: { message: 'Not Found', code: 404 } },
      { status: 404, headers: { 'Cache-Control': CACHE_CONTROL } }
    );
  }

  const [models, vercel, routingConfig] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getVercelPricingMetadata(),
    getRuntimeGatewayRoutingConfig(),
  ]);
  const storedModel = models[modelId];

  if (!storedModel) {
    return NextResponse.json(
      { error: { message: 'Not Found', code: 404 } },
      { status: 404, headers: { 'Cache-Control': CACHE_CONTROL } }
    );
  }

  // A latest alias is served by its target, so it lists the target's endpoints and prices.
  const aliasTargetId = getOpenRouterAliasTarget(models, modelId);
  const servingModel = (aliasTargetId && models[aliasTargetId]) || storedModel;
  const vercelModel = getVercelModelForPricing(vercel, servingModel.id);
  const { reasoning: _reasoning, ...modelMetadata } = storedModel;
  const openRouterEndpoints = servingModel.endpoints.map(endpoint => {
    const pricing = getProviderDisplayPricing(endpoint.tag, endpoint.pricing, vercelModel);
    return pricing ? { ...endpoint, pricing } : endpoint;
  });
  const vercelRoutingEnabled = ![modelId, servingModel.id].some(id =>
    isVercelRoutingOptOut(id, routingConfig.vercelOptOutModels)
  );
  const vercelOnlyEndpoints = vercelRoutingEnabled
    ? getVercelOnlyProviderEndpoints(servingModel.endpoints, vercelModel?.endpoints ?? [])
    : [];

  return NextResponse.json(
    {
      data: {
        ...modelMetadata,
        endpoints: [...openRouterEndpoints, ...vercelOnlyEndpoints],
      },
    },
    { headers: { 'Cache-Control': CACHE_CONTROL } }
  );
}

/**
 * The Vercel endpoints of providers that serve the model through Vercel AI Gateway only, tagged
 * with Vercel's provider id. Providers OpenRouter also lists are already priced from both gateways.
 */
function getVercelOnlyProviderEndpoints(
  openRouterEndpoints: readonly Endpoint[],
  vercelEndpoints: readonly Endpoint[]
): Endpoint[] {
  const openRouterProviders = openRouterEndpoints.flatMap(
    endpoint => endpoint.tag ?? endpoint.provider_name ?? []
  );
  return vercelEndpoints.flatMap(endpoint => {
    const provider = endpoint.provider_name ?? endpoint.tag;
    if (
      !provider ||
      openRouterProviders.some(openRouterProvider =>
        isVercelEndpointOfProvider(endpoint, openRouterProvider)
      )
    ) {
      return [];
    }
    const { pricing: vercelPricing, ...rest } = endpoint;
    const pricing = getModelDisplayPricing(vercelPricing);
    return [{ ...rest, tag: provider, provider_name: provider, ...(pricing && { pricing }) }];
  });
}
