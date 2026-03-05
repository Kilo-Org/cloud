import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/gastown/token
 *
 * Mints a short-lived (1 hour) Kilo JWT that the browser can use to
 * authenticate directly with the Gastown Cloudflare Worker.
 *
 * The browser authenticates to this endpoint via the NextAuth session cookie
 * (same-origin). The returned token is sent as `Authorization: Bearer <token>`
 * to the worker's tRPC endpoint (cross-origin).
 *
 * The JWT includes `isAdmin` and `apiTokenPepper` so the worker can verify
 * admin access and mint kilo API tokens without a DB round-trip.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = generateApiToken(user, { isAdmin: true }, { expiresIn: ONE_HOUR_SECONDS });
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // 55 min (5 min buffer before 1h expiry)

  return NextResponse.json({ token, expiresAt });
}
