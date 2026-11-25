import { NextResponse } from 'next/server';
import * as z from 'zod';
import { revokeDeviceSessionByRefreshToken } from '@/lib/auth/device-sessions';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

const requestSchema = z.object({
  refreshToken: z.string().min(1),
});

/**
 * Native sign-out revocation by refresh token. The authenticated revoke
 * (`user.revokeCurrentDeviceSession`) can fail after the client has already
 * deleted its credential pair — offline, a deadline, a 5xx, or an access token
 * that expired first — and then the session row stays live. The client keeps
 * the refresh token for exactly this case.
 *
 * Response contract:
 *   200 { outcome: 'revoked' }         — the session is revoked now
 *   200 { outcome: 'already_revoked' } — it was revoked before this call
 *   200 { outcome: 'unknown_token' }   — no session row for this token
 *   400 { error: 'INVALID_REQUEST' }   — invalid request body
 *
 * Every 200 is a settled outcome, so the client stops retrying it. A non-200
 * answer means the outcome is unknown, and the client retries under its own
 * bound. A refusal is never an error the caller must interpret: the token is
 * the credential, and the route only ends the session that token names.
 */
export const POST = withRestTiming('/api/auth/native/revoke', async (request: Request) => {
  const body = await request.json().catch(() => undefined);
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const outcome = await revokeDeviceSessionByRefreshToken(validation.data.refreshToken);
  return NextResponse.json(outcome, { status: 200 });
});
