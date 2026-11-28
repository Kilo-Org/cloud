import {
  AutoRoutingDeniedModelsRequestSchema,
  type AutoRoutingDeniedModelsResponse,
} from '@kilocode/auto-routing-contracts';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import { TRPCError } from '@trpc/server';
import { NextResponse, type NextRequest } from 'next/server';
import { deniedAutoRoutingModelIdsForMember } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-denied-models';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';

// Internal: the auto-routing worker's CLI decide path applies the gateway's own organization
// model policy to a custom router's gateway entries (ADR 0005).
export async function handleAutoRoutingDeniedModelsRequest(
  request: NextRequest
): Promise<NextResponse> {
  const token = extractBearerToken(request.headers.get('authorization'));
  // A request without a credential is refused without reading the expected value.
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let expected: string;
  try {
    expected = await readInternalApiSecret();
  } catch {
    // The secret source is unavailable, not the credential wrong: the caller retries a 5xx. The
    // error is neither logged nor returned.
    return NextResponse.json({ error: 'Unavailable' }, { status: 503 });
  }
  if (!expected || !timingSafeEqual(token, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  observeInternalAuth(
    'ai-gateway',
    'auto_routing_denied_models',
    'legacy_shared_secret',
    callerLabel(request.headers.get(INTERNAL_CALLER_HEADER))
  );
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
