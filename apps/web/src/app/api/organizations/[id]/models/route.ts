import type { NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { addAutoRoutingModels } from '@/lib/ai-gateway/auto-routing-models';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
