import { NextResponse } from 'next/server';
import { pollDeviceAuthRequest, denyDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import crypto from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

type RouteContext = {
  params: Promise<{ code: string }>;
};

// ──────────────── legacy poll ────────────────
// @ponytail: remove this GET after all shipped clients migrate to POST /api/device-auth/token

export async function GET(_request: Request, context: RouteContext) {
  const { code } = await context.params;

  if (!code) {
    return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
  }

  Sentry.captureMessage('legacy-poll-device-auth', { level: 'info', extra: { code } });

  const result = await pollDeviceAuthRequest(code);

  // Return appropriate status codes based on the result
  switch (result.status) {
    case 'pending':
      return NextResponse.json({ status: 'pending' }, { status: 202 });

    case 'approved':
      return NextResponse.json(
        {
          status: 'approved',
          token: result.token,
          userId: result.userId,
          userEmail: result.userEmail,
        },
        { status: 200 }
      );

    case 'denied':
      return NextResponse.json({ status: 'denied' }, { status: 403 });

    case 'expired':
      return NextResponse.json({ status: 'expired' }, { status: 410 });

    default:
      return NextResponse.json({ error: 'Unknown status' }, { status: 500 });
  }
}

// ──────────────── deny with viewer token ────────────────

const DEVICE_AUTH_DENY_RATE_LIMIT_ID = 'device-auth-deny';

function getDenyRateLimitKey(userId: string): string {
  return crypto.createHmac('sha256', NEXTAUTH_SECRET).update(userId).digest('base64url');
}

export async function DELETE(request: Request, context: RouteContext) {
  const { code } = await context.params;

  if (!code) {
    return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
  }

  // Authenticate the user
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  // Rate limit deny attempts
  const { rateLimited } = await checkRateLimit(DEVICE_AUTH_DENY_RATE_LIMIT_ID, {
    request,
    rateLimitKey: getDenyRateLimitKey(user.id),
  });

  if (rateLimited) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please try again later.' },
      { status: 429 }
    );
  }

  // Verify viewer token
  const viewerToken = request.headers.get('x-device-auth-viewer-token');
  const verified = verifyDeviceAuthViewerToken(viewerToken);

  if (!verified) {
    return NextResponse.json({ error: 'Invalid or expired viewer token' }, { status: 403 });
  }

  if (verified.code !== code) {
    return NextResponse.json({ error: 'Viewer token code mismatch' }, { status: 403 });
  }

  if (verified.userId !== user.id) {
    return NextResponse.json({ error: 'Viewer token user mismatch' }, { status: 403 });
  }

  try {
    await denyDeviceAuthRequest(code);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Device authorization request not found') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      if (error.message === 'Device authorization request is not pending') {
        return NextResponse.json(
          { error: 'Device authorization request can no longer be denied' },
          { status: 409 }
        );
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    Sentry.captureException(error instanceof Error ? error : new Error(message));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
