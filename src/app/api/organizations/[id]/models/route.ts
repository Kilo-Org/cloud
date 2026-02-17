import { NextResponse, type NextRequest } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === 'development') {
    const data = await getEnhancedOpenRouterModels();

    return NextResponse.json(data);
  }

  const organizationId = (await params).id;

  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    return caller.organizations.settings.listAvailableModels({ organizationId });
  });
}
