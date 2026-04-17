import type { NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { filterByFeature } from '@/lib/ai-gateway/models';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));

  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({ organizationId });
    return { ...result, data: filterByFeature(result.data, feature) };
  });
}
