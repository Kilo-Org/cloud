import type { NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { filterByFeature } from '@/lib/ai-gateway/models';
import { resolveOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils.server';
import { TRPCError } from '@trpc/server';
import { addAutoRoutingModels } from '@/lib/ai-gateway/auto-routing-models';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const routeIdentifier = decodeURIComponent((await params).id);
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));

  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    const organizationId = await resolveOrganizationRouteIdentifier(routeIdentifier);
    if (!organizationId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    const result = await caller.organizations.settings.listAvailableModels({ organizationId });
    return {
      ...result,
      data: await addAutoRoutingModels(filterByFeature(result.data, feature)),
    };
  });
}
