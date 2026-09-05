import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getUserFromBearerForCredentialExchange,
  getUserFromSessionForCredentialIssuance,
} from '@/lib/user/server';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { APP_URL } from '@/lib/constants';
import * as z from 'zod';
import {
  nativeCredentialFormatSchema,
  type NativeCredentialFormat,
  type NativeSessionCredentials,
} from '@kilocode/app-shared/native-auth';

const requestSchema = z.object({ credentialFormat: nativeCredentialFormatSchema.optional() });

function credentialResponse(credentials: NativeSessionCredentials) {
  return {
    token: credentials.token,
    refreshToken: credentials.refreshToken,
    expiresIn: credentials.expiresIn,
    ...('metadata' in credentials && credentials.metadata
      ? { metadata: credentials.metadata }
      : {}),
  };
}

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

  const text = await request.text();
  let credentialFormat: NativeCredentialFormat | undefined;
  if (text.length > 0) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const validation = requestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    credentialFormat = validation.data.credentialFormat;
  }

  const sessionId = await createDeviceSession({
    userId: auth.user.id,
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  const pair = credentialFormat
    ? await issueSessionCredentials(auth.user, sessionId, { credentialFormat })
    : await issueSessionCredentials(auth.user, sessionId);

  return NextResponse.json(
    {
      ...credentialResponse(pair),
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
