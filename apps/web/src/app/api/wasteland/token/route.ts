import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { generateApiToken } from '@/lib/tokens';
import { getUserOrgMemberships } from '@/lib/organizations/organizations';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/wasteland/token
 *
 * Mints a short-lived (1 hour) Kilo JWT that the browser can use to
 * authenticate directly with the Wasteland Cloudflare Worker.
 *
 * The browser authenticates to this endpoint via the NextAuth session cookie
 * (same-origin). The returned token is sent as `Authorization: Bearer <token>`
 * to the worker's tRPC endpoint (cross-origin).
 *
 * The JWT includes `isAdmin`, `apiTokenPepper`, and `orgMemberships` so the
 * worker can enforce access and check org membership without DB round-trips.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const orgMemberships = await getUserOrgMemberships(user.id);

  const token = generateApiToken(
    user,
    { isAdmin: user.is_admin, orgMemberships },
    { expiresIn: ONE_HOUR_SECONDS }
  );
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

  return NextResponse.json({ token, expiresAt });
}
