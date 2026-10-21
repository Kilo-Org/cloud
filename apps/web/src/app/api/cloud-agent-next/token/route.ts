import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { isResourceTokenIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  createControlTokenForRequest,
  isModernResourceDelegationRequest,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';

const requestSchema = z.object({ organizationId: z.uuid().optional() }).strict();
const responseHeaders = { 'Cache-Control': 'no-store' };

function errorResponse(status: number, error: string) {
  return NextResponse.json(failureResult(error), { status, headers: responseHeaders });
}

async function isLegacySource(request: Request): Promise<boolean> {
  try {
    return !(await isModernResourceDelegationRequest(request.headers));
  } catch {
    // An unverifiable bearer is not a legacy source; the issuer rejects it with 401.
    return false;
  }
}

/**
 * Exchange a personal CLI/API bearer for a Cloud Agent control token.
 * POST JSON: {} for personal scope, or { organizationId } for organization scope.
 * Without a body organizationId, the x-kilocode-organizationid header selects the scope.
 *
 * The token has the cloud-agent-next audience and lasts at most 15 minutes, capped by the
 * source credential's expiry. The Cloud Agent Worker and /api/cloud-agent-next/balance accept
 * it; /api/trpc/* and /api/cloud-agent-next/sessions/stream-ticket do not, so the client keeps
 * the source credential for those. Organization-bound source credentials are rejected.
 *
 * 200 { token, expiresAt }; errors are { success: false, error }:
 * - 400 invalid JSON, unknown fields, or body/header organization mismatch
 * - 401 missing, invalid, expired, revoked, or exchanged bearer; body organization non-member
 * - 403 delegated, org-bound, or restricted legacy credential; header organization non-member
 * - 503 issuance disabled for this credential (rollout gate off)
 */
async function postTokenHandler(request: Request) {
  if (!extractBearerToken(request.headers.get('authorization'))) {
    return errorResponse(401, 'Bearer authentication is required');
  }

  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) {
    authFailedResponse.headers.set('Cache-Control', 'no-store');
    return authFailedResponse;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }
  const input = requestSchema.safeParse(body);
  if (!input.success) {
    return errorResponse(400, 'Expected an object with an optional organizationId');
  }
  if (organizationId && input.data.organizationId && input.data.organizationId !== organizationId) {
    return errorResponse(400, 'organizationId does not match the organization header');
  }

  // This endpoint must never return the control issuer's legacy compatibility token.
  // Modern sources reach the issuer, which keeps its rollback rules for them.
  if (!isResourceTokenIssuanceEnabled('cloud-agent-next') && (await isLegacySource(request))) {
    return errorResponse(503, 'Cloud Agent token issuance is unavailable');
  }

  try {
    const { token, expiresAt } = await createControlTokenForRequest(user, 'cloud-agent-next', {
      headers: request.headers,
      organizationId: input.data.organizationId ?? organizationId,
      tokenSource: 'cloud-agent',
      expiresIn: 15 * 60,
    });
    return NextResponse.json({ token, expiresAt }, { headers: responseHeaders });
  } catch (error) {
    if (error instanceof TypedResourceDelegationError) {
      return errorResponse(error.status, error.message);
    }
    throw error;
  }
}

export const POST = withRestTiming('/api/cloud-agent-next/token', postTokenHandler);
