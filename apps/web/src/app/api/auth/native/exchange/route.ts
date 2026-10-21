import { NextResponse } from 'next/server';
import { captureMessage } from '@sentry/nextjs';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { requireAdmissionPayload, verifyAdmissionAsync } from '@/lib/auth/native-admission';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

/**
 * Token exchange endpoint. Authenticates with the existing long-lived bearer
 * token, creates a device session, and returns a short-lived token pair.
 *
 * The old token is NOT invalidated. If the client crashes mid-exchange, it
 * must still be able to start over with the same long-lived token. The old
 * token dies of natural expiry.
 *
 * The device must prove it is attested before any credential is read, because
 * this endpoint mints the same mobile credentials as the sign-in exchange.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken, expiresIn }
 *   401 — invalid or expired existing token
 *   403 — blocked user
 *   403 { error: 'ADMISSION_REQUIRED' } — missing, malformed, or refused proof
 *   500 { error: 'INTERNAL_ERROR' } — admission provider infrastructure error
 */
export const POST = withRestTiming('/api/auth/native/exchange', async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  const admissionPayload = requireAdmissionPayload(
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  );
  if (!admissionPayload) {
    return NextResponse.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 });
  }

  try {
    const verified = await verifyAdmissionAsync(admissionPayload);
    if (!verified.ok) {
      captureMessage('native_admission_refused');
      return NextResponse.json({ error: verified.errorCode }, { status: 403 });
    }
  } catch {
    captureMessage('native_admission_unavailable');
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }

  const auth = request.headers.has('authorization')
    ? await getUserFromBearerForCredentialExchange(request.headers, { legacy: 'five-year-api' })
    : await getSessionAuth(request);

  if (auth.authFailedResponse) {
    return auth.authFailedResponse;
  }

  if (!auth.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sessionId = await createDeviceSession({
    userId: auth.user.id,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  const pair = await issueSessionCredentials(auth.user, sessionId);

  return NextResponse.json(
    {
      token: pair.token,
      refreshToken: pair.refreshToken,
      expiresIn: pair.expiresIn,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
});

async function getSessionAuth(request: Request) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(APP_URL).origin) {
    return {
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Invalid origin' }, { status: 403 }),
    };
  }

  return getUserFromSessionForCredentialIssuance();
}
