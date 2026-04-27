import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/kilo-chat/token
 *
 * Mints a short-lived (1 hour) Kilo JWT that the browser can use to
 * authenticate directly with the kilo-chat Cloudflare Worker.
 *
 * The browser authenticates to this endpoint via the NextAuth session cookie
 * (same-origin). The returned token is sent as `Authorization: Bearer <token>`
 * to the worker's HTTP endpoints (cross-origin).
 *
 * The worker verifies the token using verifyKiloToken() with NEXTAUTH_SECRET,
 * extracting kiloUserId from the payload. Sandbox ownership is verified
 * server-side by the kilo-chat worker via Hyperdrive.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = generateApiToken(
    user,
    { tokenSource: 'kilo-chat' },
    { expiresIn: ONE_HOUR_SECONDS }
  );
  const expiresAt = new Date(Date.now() + ONE_HOUR_SECONDS * 1000).toISOString();

  return NextResponse.json({ token, expiresAt });
}
