import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@/lib/user/server';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { APP_URL } from '@/lib/constants';

/**
 * Token exchange endpoint. Authenticates with the existing long-lived bearer
 * token, creates a device session, and returns a short-lived token pair.
 *
 * The old token is NOT invalidated. If the client crashes mid-exchange, it
 * must still be able to start over with the same long-lived token. The old
 * token dies of natural expiry.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken, expiresIn }
 *   401 — invalid or expired existing token
 *   403 — blocked user
 */
export async function POST(request: NextRequest) {
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
}

async function getSessionAuth(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin !== new URL(APP_URL).origin) {
    return {
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Invalid origin' }, { status: 403 }),
    };
  }

  return getUserFromSessionForCredentialIssuance();
}
