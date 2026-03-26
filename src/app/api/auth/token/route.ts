import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/auth/token
 *
 * Mints a short-lived (1 hour) Kilo JWT for any authenticated user.
 * The browser authenticates to this endpoint via the NextAuth session cookie.
 * The returned token can be sent as `Authorization: Bearer <token>` to
 * API endpoints that call getUserFromAuth.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = generateApiToken(user, {}, { expiresIn: ONE_HOUR_SECONDS });
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

  return NextResponse.json({ token, expiresAt });
}
