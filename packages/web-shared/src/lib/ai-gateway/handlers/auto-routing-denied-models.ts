import {
  AutoRoutingDeniedModelsRequestSchema,
  type AutoRoutingDeniedModelsResponse,
} from '@kilocode/auto-routing-contracts';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import { deniedAutoRoutingModelIdsForMember } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-denied-models';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

// Internal: the auto-routing worker's CLI decide path applies the gateway's own organization
// model policy to a custom router's gateway entries (ADR 0005).
export async function handleAutoRoutingDeniedModelsRequest(
  request: NextRequest
): Promise<NextResponse> {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!INTERNAL_API_SECRET || !token || !timingSafeEqual(token, INTERNAL_API_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = AutoRoutingDeniedModelsRequestSchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const deniedModelIds = await deniedAutoRoutingModelIdsForMember(parsed.data);
    return NextResponse.json({ deniedModelIds } satisfies AutoRoutingDeniedModelsResponse);
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'NOT_FOUND' || error.code === 'UNAUTHORIZED')
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
