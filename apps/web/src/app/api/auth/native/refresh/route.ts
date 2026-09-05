import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { rotateRefreshToken } from '@/lib/auth/device-sessions';
import {
  nativeCredentialFormatSchema,
  type NativeSessionCredentials,
} from '@kilocode/app-shared/native-auth';

const requestSchema = z.object({
  refreshToken: z.string().min(1),
  credentialFormat: nativeCredentialFormatSchema.optional(),
});

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
 * Native refresh endpoint. Accepts a refresh token and returns a new
 * access/refresh pair.
 *
 * Response contract (frozen — mobile client is built against it):
 *   200 { token, refreshToken, expiresIn }
 *   401 { error: 'INVALID_REFRESH_TOKEN' }  — unknown, expired, or reused refresh token
 *   401 { error: 'SESSION_REVOKED' }        — the parent device session was revoked
 *   401 { error: 'USER_BLOCKED' }           — the user's account is blocked
 *   400                                      — invalid request body
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => undefined);
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const { refreshToken, credentialFormat } = validation.data;

  const result = credentialFormat
    ? await rotateRefreshToken(refreshToken, { credentialFormat })
    : await rotateRefreshToken(refreshToken);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  return NextResponse.json(
    {
      ...credentialResponse(result),
    },
    { status: 200 }
  );
}
