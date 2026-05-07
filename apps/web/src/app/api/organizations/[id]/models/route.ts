import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { filterByFeature } from '@/lib/ai-gateway/models';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));
  const rawOutputModalities = request.nextUrl.searchParams.get('output_modalities');
  if (rawOutputModalities !== null && rawOutputModalities !== 'embeddings') {
    return NextResponse.json(
      {
        error: 'Invalid output_modalities',
        message: "Only 'embeddings' is supported for output_modalities",
      },
      { status: 400 }
    );
  }
  const outputModalities = rawOutputModalities ?? undefined;

  return handleTRPCRequest<OpenRouterModelsResponse>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({
      organizationId,
      outputModalities,
    });
    return { ...result, data: filterByFeature(result.data, feature) };
  });
}
