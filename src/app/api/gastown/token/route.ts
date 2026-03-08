import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';

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
 * Access is controlled by the `gastown-access` PostHog feature flag.
 * The JWT includes `gastownAccess`, `isAdmin`, and `apiTokenPepper` so
 * the worker can enforce access and mint kilo API tokens without a DB
 * round-trip.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const hasAccess = await isGastownEnabled(user.id);

  if (!hasAccess) {
    return NextResponse.json({ error: 'Gastown access denied' }, { status: 403 });
  }

  const token = generateApiToken(
    user,
    { isAdmin: user.is_admin, gastownAccess: true },
    { expiresIn: ONE_HOUR_SECONDS }
  );
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

  return NextResponse.json({ token, expiresAt });
}
