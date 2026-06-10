import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { FEATURE_HEADER, validateFeatureHeader } from '@/lib/feature-detection';
import { filterByFeature } from '@/lib/ai-gateway/models';

const BodySchema = z.object({ modelId: z.string().trim().min(1) });

type ValidationResult = { valid: true } | { valid: false; reason: 'unavailable' };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<{ error: string; message?: string } | ValidationResult>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const bodyResult = BodySchema.safeParse(body);
  if (!bodyResult.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: z.treeifyError(bodyResult.error) },
      { status: 400 }
    );
  }

  const organizationId = (await params).id;
  const feature = validateFeatureHeader(request.headers.get(FEATURE_HEADER));

  return handleTRPCRequest<ValidationResult>(request, async caller => {
    const result = await caller.organizations.settings.listAvailableModels({ organizationId });
    const available = filterByFeature(result.data, feature).some(
      model => model.id === bodyResult.data.modelId
    );
    return available ? { valid: true } : { valid: false, reason: 'unavailable' };
  });
}
