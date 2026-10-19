import { NextResponse } from 'next/server';
import {
  denyDeviceAuthRequest,
  getDeviceAuthRequest,
  isDeviceAuthRequestExpired,
} from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import crypto from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

type RouteContext = {
  params: Promise<{ code: string }>;
};

// ──────────────── status-only poll (temporary) ────────────────
// @ponytail: remove this GET after all shipped clients migrate.

export const GET = withRestTiming(
  '/api/device-auth/codes/[code]',
  async (_request: Request, context: RouteContext) => {
    const { code } = await context.params;

    if (!code) {
      return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
    }

    const request = await getDeviceAuthRequest(code);
    if (!request) {
      return NextResponse.json({ status: 'expired' }, { status: 410 });
    }
    if (isDeviceAuthRequestExpired(request) || request.status === 'consumed') {
      return NextResponse.json({ status: 'expired' }, { status: 410 });
    }
    switch (request.status) {
      case 'pending':
        return NextResponse.json({ status: 'pending' }, { status: 202 });
      case 'denied':
        return NextResponse.json({ status: 'denied' }, { status: 403 });
      default:
        // Approved or unknown: the caller cannot complete sign-in through
        // this endpoint, so answer with the terminal status.
        return NextResponse.json({ status: 'expired' }, { status: 410 });
    }
  }
);

// ──────────────── deny with viewer token ────────────────

const DEVICE_AUTH_DENY_RATE_LIMIT_ID = 'device-auth-deny';

function getDenyRateLimitKey(userId: string): string {
  return crypto.createHmac('sha256', NEXTAUTH_SECRET).update(userId).digest('base64url');
}

export const DELETE = withRestTiming(
  '/api/device-auth/codes/[code]',
  async (request: Request, context: RouteContext) => {
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
);
