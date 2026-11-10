import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { getProfileOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isPagesAuthClient } from '@/lib/pages-auth/pages-auth-clients';
import { PAGES_AUTH_STATE_PATTERN, verifyPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';

const ExchangeBodySchema = z.object({
  code: z.string().min(1).max(2048),
  origin: z.string().min(1).max(200),
  state: z.string().regex(PAGES_AUTH_STATE_PATTERN),
});

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** The bearer credential of a request, or null. */
function bearerOf(request: Request): string | null {
  return /^Bearer (.+)$/u.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

/**
 * Trades a Pages sign-in code for the person it names.
 *
 * A Pages deployment calls this from its server with the code its callback
 * received, its own origin, the `state` it started the sign-in with, and its
 * secret as a bearer credential. The answer is identity only: an account id, a
 * name and the person's organizations. No Kilo token is issued.
 *
 * A caller that is not a configured deployment gets 401 before the code is
 * checked. A code that is forged, stale, or minted for another deployment or
 * another `state` gets 400. An account that no longer exists or is blocked
 * gets 403.
 */
export const POST = withRestTiming('/api/pages-auth/exchange', async (request: Request) => {
  const body: unknown = await request.json().catch(() => null);
  const parsed = ExchangeBodySchema.safeParse(body);
  if (!parsed.success) return refuse(400, 'invalid_request');
  const { code, origin, state } = parsed.data;

  if (!isPagesAuthClient(origin, bearerOf(request))) return refuse(401, 'invalid_client');

  const grant = verifyPagesAuthCode(code);
  if (!grant || grant.origin !== origin || grant.state !== state) {
    return refuse(400, 'invalid_code');
  }

  const user = await findUserById(grant.userId);
  if (!user || user.blocked_reason) return refuse(403, 'account_unavailable');

  const organizations = await getProfileOrganizations(user.id, { excludeAccessBlocked: true });

  return NextResponse.json(
    {
      user: { id: user.id, name: user.google_user_name },
      organizations,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
});
