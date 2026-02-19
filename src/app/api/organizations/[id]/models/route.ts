import type { NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;
  const includeSlackbotOnly = request.nextUrl.searchParams.get('includeSlackbotOnly') === 'true';

  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    return caller.organizations.settings.listAvailableModels({
      organizationId,
      includeSlackbotOnly,
    });
  });
}
