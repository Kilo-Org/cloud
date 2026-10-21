import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { isResourceTokenIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  createControlTokenForRequest,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';

const requestSchema = z.object({ organizationId: z.uuid().optional() }).strict();
const responseHeaders = { 'Cache-Control': 'no-store' };

/**
 * Exchange a CLI/API bearer for a Cloud Agent control token.
 * POST JSON: {} for personal scope, or { organizationId } for organization scope.
 * The token authorizes the Cloud Agent service, including environments that share auth.
 */
export async function POST(request: Request) {
  if (!extractBearerToken(request.headers.get('authorization'))) {
    return NextResponse.json(
      { error: 'Bearer authentication is required' },
      { status: 401, headers: responseHeaders }
    );
  }

  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) {
    authFailedResponse.headers.set('Cache-Control', 'no-store');
    return authFailedResponse;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: responseHeaders }
    );
  }
  const input = requestSchema.safeParse(body);
  if (!input.success) {
    return NextResponse.json(
      { error: 'Expected an object with an optional organizationId' },
      { status: 400, headers: responseHeaders }
    );
  }

  // This endpoint must never return the control issuer's legacy compatibility token.
  if (!isResourceTokenIssuanceEnabled('cloud-agent-next')) {
    return NextResponse.json(
      { error: 'Cloud Agent token issuance is unavailable' },
      { status: 503, headers: responseHeaders }
    );
  }

  try {
    const { token, expiresAt } = await createControlTokenForRequest(user, 'cloud-agent-next', {
      headers: request.headers,
      organizationId: input.data.organizationId,
      tokenSource: 'cloud-agent',
      expiresIn: 15 * 60,
    });
    return NextResponse.json({ token, expiresAt }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof TypedResourceDelegationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: responseHeaders }
      );
    }
    throw error;
  }
}
