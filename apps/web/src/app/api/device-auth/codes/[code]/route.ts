import { NextResponse } from 'next/server';
import {
  pollDeviceAuthRequest,
  denyDeviceAuthRequest,
  cancelDeviceAuthRequest,
  DEVICE_AUTH_REFUSAL_CODES,
  DeviceAuthRefusalError,
} from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import crypto from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

type RouteContext = {
  params: Promise<{ code: string }>;
};

const ROUTE = '/api/device-auth/codes/[code]';

// ──────────────── legacy poll ────────────────
// @ponytail: remove this GET after all shipped clients migrate to POST /api/device-auth/token

export const GET = withRestTiming(ROUTE, async (request: Request, context?: RouteContext) => {
  // A poll that redeems or is refused is a redemption attempt; a pending poll
  // records nothing.
  const attempt: AuthAuditAttempt = { action: 'auth.device_auth.redeem', method: 'legacy_poll' };
  return auditAuthRoute(authAuditRequestFromHeaders(request.headers, ROUTE), attempt, () =>
    pollLegacy(attempt, context)
  );
});

async function pollLegacy(attempt: AuthAuditAttempt, context?: RouteContext): Promise<Response> {
  const code = (await context?.params)?.code;

  if (!code) {
    attempt.failureReason = 'invalid_request';
    return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
  }

  const result = await pollDeviceAuthRequest(code);
  attempt.userId = result.userId ?? null;
  if (result.requestId) attempt.metadata = { deviceAuthRequestId: result.requestId };

  // Return appropriate status codes based on the result
  switch (result.status) {
    case 'pending':
      attempt.skipSuccessRow = true;
      return NextResponse.json({ status: 'pending' }, { status: 202 });

    case 'approved':
      return NextResponse.json(
        {
          status: 'approved',
          token: result.token,
          userId: result.userId,
          userEmail: result.userEmail,
          requestingClient: result.requestingClient ?? null,
          clientConfirmed: result.clientConfirmed === true,
          ...(result.pendingLink ? { pendingLink: result.pendingLink } : {}),
        },
        { status: 200 }
      );

    case 'denied':
      attempt.failureReason = 'denied';
      return NextResponse.json({ status: 'denied' }, { status: 403 });

    case 'expired':
      attempt.failureReason = 'expired';
      return NextResponse.json({ status: 'expired' }, { status: 410 });

    default:
      attempt.failureReason = 'unknown_status';
      return NextResponse.json({ error: 'Unknown status' }, { status: 500 });
  }
}

// ──────────────── deny with viewer token ────────────────

const DEVICE_AUTH_DENY_RATE_LIMIT_ID = 'device-auth-deny';

function getDenyRateLimitKey(userId: string): string {
  return crypto.createHmac('sha256', NEXTAUTH_SECRET).update(userId).digest('base64url');
}

/** The device presents the poll secret as the code, so the secret never becomes a rate-limit key in the clear. */
function getDeviceCancelRateLimitKey(code: string): string {
  return crypto.createHmac('sha256', NEXTAUTH_SECRET).update(code).digest('base64url');
}

/**
 * The refusal code decides the status, so copy edits cannot change it. A refusal
 * this route does not answer with is a bug: it is reported and answered as 500.
 */
function deviceAuthFailureResponse(
  error: unknown,
  notPendingMessage: string,
  attempt: AuthAuditAttempt
): Response {
  if (error instanceof DeviceAuthRefusalError) {
    if (error.requestId) attempt.metadata = { deviceAuthRequestId: error.requestId };
    if (error.code === DEVICE_AUTH_REFUSAL_CODES.requestNotFound) {
      return NextResponse.json({ error: error.code, message: 'Not found' }, { status: 404 });
    }
    if (error.code === DEVICE_AUTH_REFUSAL_CODES.requestNotPending) {
      return NextResponse.json({ error: error.code, message: notPendingMessage }, { status: 409 });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  Sentry.captureException(error instanceof Error ? error : new Error(message));
  attempt.failureReason = 'internal_error';
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

async function cancelFromDevice(
  code: string,
  request: Request,
  attempt: AuthAuditAttempt
): Promise<Response> {
  const { rateLimited } = await checkRateLimit(DEVICE_AUTH_DENY_RATE_LIMIT_ID, {
    request,
    rateLimitKey: getDeviceCancelRateLimitKey(code),
  });

  if (rateLimited) {
    attempt.failureReason = 'rate_limited';
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: 429 }
    );
  }

  try {
    const cancelled = await cancelDeviceAuthRequest(code);
    attempt.metadata = { deviceAuthRequestId: cancelled.requestId };
  } catch (error) {
    return deviceAuthFailureResponse(
      error,
      'Device authorization request can no longer be cancelled',
      attempt
    );
  }

  return NextResponse.json({ success: true });
}

async function denyFromViewer(
  code: string,
  viewerToken: string,
  request: Request,
  attempt: AuthAuditAttempt
): Promise<Response> {
  // Authenticate the user
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }
  attempt.userId = user.id;

  // Rate limit deny attempts
  const { rateLimited } = await checkRateLimit(DEVICE_AUTH_DENY_RATE_LIMIT_ID, {
    request,
    rateLimitKey: getDenyRateLimitKey(user.id),
  });

  if (rateLimited) {
    attempt.failureReason = 'rate_limited';
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: 429 }
    );
  }

  // Verify viewer token
  const verified = verifyDeviceAuthViewerToken(viewerToken);

  if (!verified) {
    attempt.failureReason = 'invalid_viewer_token';
    return NextResponse.json({ error: 'Invalid or expired viewer token' }, { status: 403 });
  }

  if (verified.code !== code) {
    attempt.failureReason = 'viewer_token_code_mismatch';
    return NextResponse.json({ error: 'Viewer token code mismatch' }, { status: 403 });
  }

  if (verified.userId !== user.id) {
    attempt.failureReason = 'viewer_token_user_mismatch';
    return NextResponse.json({ error: 'Viewer token user mismatch' }, { status: 403 });
  }

  try {
    const denied = await denyDeviceAuthRequest(code);
    attempt.metadata = { deviceAuthRequestId: denied.requestId };
  } catch (error) {
    return deviceAuthFailureResponse(
      error,
      'Device authorization request can no longer be denied',
      attempt
    );
  }

  return NextResponse.json({ success: true });
}

export const DELETE = withRestTiming(ROUTE, async (request: Request, context?: RouteContext) => {
  const viewerToken = request.headers.get('x-device-auth-viewer-token');
  // Without a viewer token the caller is the device itself, presenting the
  // poll secret that the poll GET accepts as `code`.
  const attempt: AuthAuditAttempt = {
    action: viewerToken === null ? 'auth.device_auth.cancel' : 'auth.device_auth.deny',
  };
  return auditAuthRoute(authAuditRequestFromHeaders(request.headers, ROUTE), attempt, async () => {
    const code = (await context?.params)?.code;

    if (!code) {
      attempt.failureReason = 'invalid_request';
      return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
    }

    return viewerToken === null
      ? cancelFromDevice(code, request, attempt)
      : denyFromViewer(code, viewerToken, request, attempt);
  });
});
