import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { rotateRefreshToken } from '@/lib/auth/device-sessions';

const requestSchema = z.object({
  refreshToken: z.string().min(1),
});

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

  const { refreshToken } = validation.data;

  const result = await rotateRefreshToken(refreshToken);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }

  return NextResponse.json(
    {
      token: result.token,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    },
    { status: 200 }
  );
}
