import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { ORGANIZATION_MODEL_AUDIENCES } from '@kilocode/app-shared/organizations';
import type { OpenRouterModelsResponse } from '@kilocode/web-shared/lib/organizations/organization-types';
import { handleTRPCRequest } from '@kilocode/web-shared/lib/organizations/organization-settings-route-handler';
import { addAutoRoutingModels } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-models';

const AudienceSchema = z.enum(ORGANIZATION_MODEL_AUDIENCES).optional();

export async function handleOrganizationModelsRequest(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const organizationId = (await params).id;
  const audience = AudienceSchema.safeParse(
    request.nextUrl.searchParams.get('audience') ?? undefined
  );
  if (!audience.success) {
    return NextResponse.json({ error: 'Invalid audience' }, { status: 400 });
  }
  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({
      organizationId,
      audience: audience.data,
    });
    return {
      ...result,
      data: await addAutoRoutingModels(result.data),
    };
  });
}
