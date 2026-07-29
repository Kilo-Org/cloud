import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { getModelDisplayPricing } from '@/lib/ai-gateway/providers/openrouter';
import { applyCustomPricingToPricing } from '@/lib/ai-gateway/custom-pricing';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ provider: string; model: string }> }
) {
  const { provider, model } = await params;
  const models = await getOpenRouterModelsMetadataFromDatabase();
  const storedModel = models[`${provider}/${model}`];

  if (!storedModel) {
    return NextResponse.json({ error: { message: 'Not Found', code: 404 } }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      ...storedModel,
      endpoints: storedModel.endpoints.map(endpoint => {
        if (!endpoint.pricing) return endpoint;
        const displayPricing = getModelDisplayPricing(storedModel.id, endpoint.pricing);
        return {
          ...endpoint,
          pricing: applyCustomPricingToPricing(storedModel.id, displayPricing ?? endpoint.pricing),
        };
      }),
    },
  });
}
