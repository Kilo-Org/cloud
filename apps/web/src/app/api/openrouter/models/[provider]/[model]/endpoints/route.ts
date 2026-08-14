import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getOpenRouterModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { getModelDisplayPricing } from '@/lib/ai-gateway/providers/openrouter/display-pricing';
import { applyCustomPricingToPricing } from '@/lib/ai-gateway/custom-pricing';
import { isUnavailableModel } from '@/lib/ai-gateway/unavailable-models';

const CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=60';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string; model: string }> }
) {
  const { provider, model } = await params;
  const modelId = `${provider}/${model}`;
  if (isUnavailableModel(modelId) || !(await isValidOpenRouterModelId(modelId))) {
    return NextResponse.json(
      { error: { message: 'Not Found', code: 404 } },
      { status: 404, headers: { 'Cache-Control': CACHE_CONTROL } }
    );
  }

  const models = await getOpenRouterModelsMetadataFromDatabase();
  const storedModel = models[modelId];

  if (!storedModel) {
    return NextResponse.json(
      { error: { message: 'Not Found', code: 404 } },
      { status: 404, headers: { 'Cache-Control': CACHE_CONTROL } }
    );
  }

  return NextResponse.json(
    {
      data: {
        ...storedModel,
        endpoints: storedModel.endpoints.map(endpoint => {
          if (!endpoint.pricing) return endpoint;
          const displayPricing = getModelDisplayPricing(endpoint.pricing);
          return {
            ...endpoint,
            pricing: applyCustomPricingToPricing(
              storedModel.id,
              displayPricing ?? endpoint.pricing
            ),
          };
        }),
      },
    },
    { headers: { 'Cache-Control': CACHE_CONTROL } }
  );
}
