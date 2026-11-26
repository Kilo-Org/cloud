import { NextResponse } from 'next/server';
import { consumeDeviceAuthByDeviceCode } from '@/lib/device-auth/device-auth';
import * as z from 'zod';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

const TokenBodySchema = z.object({
  deviceCode: z.string().min(1),
  supportsRefresh: z.boolean().optional(),
});

export const POST = withRestTiming('/api/device-auth/token', async (request: Request) => {
  // A poll that redeems or is refused is a redemption attempt; a pending poll
  // records nothing.
  const attempt: AuthAuditAttempt = { action: 'auth.device_auth.redeem', method: 'device_code' };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/device-auth/token'),
    attempt,
    () => redeem(request, attempt)
  );
});

async function redeem(request: Request, attempt: AuthAuditAttempt): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    attempt.failureReason = 'invalid_json';
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = TokenBodySchema.safeParse(body);
  if (!validation.success) {
    attempt.failureReason = 'invalid_request';
    return NextResponse.json(
      { error: 'Invalid request body', details: validation.error.issues },
      { status: 400 }
    );
  }

  const { deviceCode, supportsRefresh } = validation.data;

  const result = await consumeDeviceAuthByDeviceCode(deviceCode, { supportsRefresh });
  attempt.userId = result.userId ?? null;
  if (result.requestId) attempt.metadata = { deviceAuthRequestId: result.requestId };

  switch (result.status) {
    case 'pending':
      attempt.skipSuccessRow = true;
      return NextResponse.json({ status: 'pending' }, { status: 202 });

    case 'approved':
      return NextResponse.json(
        {
          status: 'approved',
          token: result.token,
          ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
          ...(result.expiresIn ? { expiresIn: result.expiresIn } : {}),
          userId: result.userId,
          userEmail: result.userEmail,
          ...(result.pendingLink ? { pendingLink: result.pendingLink } : {}),
        },
        { status: 200 }
      );

    case 'denied':
      attempt.failureReason = 'denied';
      return NextResponse.json({ status: 'denied' }, { status: 403 });

    case 'expired':
    case 'consumed':
      attempt.failureReason = result.status;
      return NextResponse.json({ status: 'expired' }, { status: 410 });

    default:
      attempt.failureReason = 'unknown_status';
      return NextResponse.json({ error: 'Unknown status' }, { status: 500 });
  }
}
