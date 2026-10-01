import type { NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { handleTRPCRequest } from '@kilocode/web-shared/lib/organizations/organization-settings-route-handler';
import { addAutoRoutingModels } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';

export async function handleOrganizationModelsRequest(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const organizationId = (await params).id;
  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({
      organizationId,
    });
    return {
      ...result,
      data: await addAutoRoutingModels(result.data),
    };
  });
}
