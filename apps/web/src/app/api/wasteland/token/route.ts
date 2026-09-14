import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import {
  createControlTokenForRequest,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';
import { recordKiloAdminElevationForRequest, serviceTarget } from '@/lib/admin/admin-access-log';

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

  try {
    const result = await createControlTokenForRequest(user, 'wasteland', {
      tokenSource: 'wasteland',
      expiresIn: ONE_HOUR_SECONDS,
      legacyExpiresIn: ONE_HOUR_SECONDS,
      extra: { isAdmin: user.is_admin },
    });
    if (result.user.is_admin) {
      await recordKiloAdminElevationForRequest({
        user: result.user,
        tokenSource: result.tokenSource,
        reason: 'service_token_mint',
        target: serviceTarget('wasteland'),
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
