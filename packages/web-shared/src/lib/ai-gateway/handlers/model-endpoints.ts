import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getOpenRouterAliasTarget } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  getProviderDisplayPricing,
  getVercelModelForPricing,
  getVercelPricingMetadata,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-endpoint-pricing';
import { isUnavailableModel } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';

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

  const [models, vercel] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getVercelPricingMetadata(),
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

  return NextResponse.json(
    {
      data: {
        ...modelMetadata,
        endpoints: servingModel.endpoints.map(endpoint => {
          const pricing = getProviderDisplayPricing(endpoint.tag, endpoint.pricing, vercelModel);
          return pricing ? { ...endpoint, pricing } : endpoint;
        }),
      },
    },
    { headers: { 'Cache-Control': CACHE_CONTROL } }
  );
}
