import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import {
  createControlTokenForRequest,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { recordKiloAdminElevationForRequest, serviceTarget } from '@/lib/admin/admin-access-log';

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
 * The JWT includes `gastownAccess`, `isAdmin`, `apiTokenPepper`, and
 * `orgMemberships` so the worker can enforce access and check org
 * membership without DB round-trips.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const hasAccess = await isGastownEnabled(user.id);

  if (!hasAccess) {
    return NextResponse.json({ error: 'Gastown access denied' }, { status: 403 });
  }

  try {
    const result = await createControlTokenForRequest(user, 'gastown', {
      tokenSource: 'gastown',
      expiresIn: 55 * 60,
      legacyExpiresIn: ONE_HOUR_SECONDS,
      extra: { isAdmin: user.is_admin, gastownAccess: true },
    });
    if (result.user.is_admin) {
      await recordKiloAdminElevationForRequest({
        user: result.user,
        tokenSource: result.tokenSource,
        reason: 'service_token_mint',
        target: serviceTarget('gastown'),
      });
    }
    return NextResponse.json({ token: result.token, expiresAt: result.expiresAt });
  } catch (error) {
    if (error instanceof TypedResourceDelegationError) {
      return NextResponse.json(
        { error: error.message, code: error.delegationCode },
        { status: error.status }
      );
    }
    throw error;
  }
}
