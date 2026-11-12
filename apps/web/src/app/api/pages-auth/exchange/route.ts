import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { getProfileOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/server';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { isPagesAuthClient } from '@/lib/pages-auth/pages-auth-clients';
import { PAGES_AUTH_STATE_PATTERN, verifyPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';
import { getUserAuthProviders } from '@/lib/user';
import { hasVerifiedPrimaryAddress } from '@/lib/user/verified-address';

const CodeExchangeSchema = z.object({
  code: z.string().min(1).max(2048),
  audience: z.string().min(1).max(200),
  state: z.string().regex(PAGES_AUTH_STATE_PATTERN),
});

const TokenExchangeSchema = z
  .object({
    token: z.string().min(1).max(4096),
    audience: z.string().min(1).max(200),
  })
  .strict();

/** The only claims a Pages token carries; anything else is not a token this route minted. */
const PAGES_TOKEN_CLAIM_NAMES: ReadonlySet<string> = new Set([
  'version',
  'kiloUserId',
  'env',
  'aud',
  'iat',
  'exp',
  'tokenPurpose',
  'credentialExchange',
]);

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

type Exchange =
  | { kind: 'code'; code: string; audience: string; state: string }
  | { kind: 'token'; token: string; audience: string };

function parseExchange(body: unknown): Exchange | null {
  if (body === null || typeof body !== 'object') return null;
  const hasCode = 'code' in body;
  const hasToken = 'token' in body;
  if (hasCode === hasToken) return null;
  if (hasCode) {
    const parsed = CodeExchangeSchema.safeParse(body);
    return parsed.success ? { kind: 'code', ...parsed.data } : null;
  }
  const parsed = TokenExchangeSchema.safeParse(body);
  return parsed.success ? { kind: 'token', ...parsed.data } : null;
}

/** The user a Pages token names, or null when it is not a valid, unexpired token for `audience`. */
async function userIdFromPagesToken(token: string, audience: string): Promise<string | null> {
  try {
    const verified = await verifyKiloTokenForPolicy(token, NEXTAUTH_SECRET, {
      audience,
      mode: 'required',
    });
    const { claims } = verified;
    if (
      claims.aud !== audience ||
      claims.tokenPurpose !== 'delegated-workload' ||
      claims.credentialExchange !== false ||
      claims.env !== process.env.NODE_ENV ||
      !verified.claimNames.every(name => PAGES_TOKEN_CLAIM_NAMES.has(name))
    ) {
      return null;
    }
    return verified.userId;
  } catch {
    return null;
  }
}

/**
 * Trades a Pages sign-in code, or a Pages-audience token, for the person it
 * names.
 *
 * A Pages deployment calls this from its server with its `audience` (`pages` or
 * `pages-dev`) and its secret as a bearer credential, plus one of:
 * - the code its callback received and the `state` it started the sign-in with
 *   (browser flow), or
 * - a token minted for it at `POST /api/auth/resource-token` (a client with no
 *   browser session, such as the CLI). The token is bound to the deployment by
 *   its audience, so one minted for `pages-dev` is refused for `pages`.
 *
 * The answer is identity only, and no Kilo token is issued:
 *
 *     { "user": { "id", "name", "verified_email"? }, "organizations": [...] }
 *
 * `verified_email` is the account's primary address, present only when a
 * sign-in method that verifies addresses carries it
 * (`hasVerifiedPrimaryAddress`). Without that proof the key is absent, never
 * null or empty: Pages honors an invitation by email only for a verified
 * address. An account with no provider rows has no proof, so it gets no key.
 * The address is in the response body only; nothing here logs it.
 *
 * A caller that is not a configured deployment gets 401 before the code or
 * token is checked. A code that is forged, stale, or minted for another
 * deployment or another `state` gets 400 `invalid_code`; a token that is
 * forged, expired or for another audience gets 400 `invalid_token`. A body
 * with both or neither of `code` and `token` gets 400 `invalid_request`.
 *
 * The account is read again, since the code was minted up to a minute ago and a
 * token up to five: one that no longer exists, is blocked, or is on a
 * blacklisted email domain gets 403. This call carries no web session, so it
 * cannot tell that the session which minted the code has since ended. A token
 * carries no pepper, so a pepper rotation is not seen for up to five minutes.
 */
export const POST = withRestTiming('/api/pages-auth/exchange', async (request: Request) => {
  const body: unknown = await request.json().catch(() => null);
  const exchange = parseExchange(body);
  if (!exchange) return refuse(400, 'invalid_request');
  const { audience } = exchange;

  const secret = extractBearerToken(request.headers.get('authorization'));
  if (!isPagesAuthClient(audience, secret)) return refuse(401, 'invalid_client');

  let userId: string;
  if (exchange.kind === 'code') {
    const grant = verifyPagesAuthCode(exchange.code);
    if (!grant || grant.audience !== audience || grant.state !== exchange.state) {
      return refuse(400, 'invalid_code');
    }
    userId = grant.userId;
  } else {
    const tokenUserId = await userIdFromPagesToken(exchange.token, audience);
    if (!tokenUserId) return refuse(400, 'invalid_token');
    userId = tokenUserId;
  }

  const user = await findUserById(userId);
  if (!user || isBlockedAccount(user) || (await isUserBlacklistedByDomain(user))) {
    return refuse(403, 'account_unavailable');
  }

  const [organizations, providers] = await Promise.all([
    getProfileOrganizations(user.id, { excludeAccessBlocked: true }),
    getUserAuthProviders(user.id),
  ]);
  const verified = hasVerifiedPrimaryAddress(user.google_user_email, providers);

  return NextResponse.json(
    {
      user: {
        id: user.id,
        name: user.google_user_name,
        ...(verified ? { verified_email: user.google_user_email } : {}),
      },
      organizations,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
});
