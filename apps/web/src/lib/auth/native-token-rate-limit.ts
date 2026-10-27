import 'server-only';
import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * Vercel Firewall rate limits for the native sign-in exchange. The rules live
 * in the project's firewall configuration; `checkRateLimit` reports an unknown
 * id as "not rate limited", so the Sentry report below is the only signal that
 * a rule has gone missing.
 *
 * The address rule runs before the admission gate, so one client address
 * cannot spend the provider calls that verification makes. The account rule
 * runs once the account is known and before any device session or refresh
 * token is written.
 */
const ADDRESS_RATE_LIMIT_ID = 'native-token-address';
const USER_RATE_LIMIT_ID = 'native-token-user';

/** The account key counts on an opaque digest, never on the address or id itself. */
function accountRateLimitKey(kiloUserId: string): string {
  const digest = createHmac('sha256', NEXTAUTH_SECRET).update(kiloUserId).digest('base64url');
  return `${USER_RATE_LIMIT_ID}:${digest}`;
}

function reportMissingRule(rateLimitId: string): void {
  captureMessage(`Firewall rate limit '${rateLimitId}' is not configured`, {
    level: 'error',
    tags: { source: 'native_token_rate_limit' },
  });
}

/** True when one client address is exchanging device credentials too fast. */
export async function isNativeTokenAddressRateLimited(request: Request): Promise<boolean> {
  const address =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';
  const { rateLimited, error } = await checkRateLimit(ADDRESS_RATE_LIMIT_ID, {
    request,
    rateLimitKey: `${ADDRESS_RATE_LIMIT_ID}:${address}`,
  });
  if (error === 'not-found') {
    reportMissingRule(ADDRESS_RATE_LIMIT_ID);
  }
  return rateLimited;
}

/** True when one account is exchanging device credentials too fast. */
export async function isNativeTokenUserRateLimited(
  request: Request,
  kiloUserId: string
): Promise<boolean> {
  const { rateLimited, error } = await checkRateLimit(USER_RATE_LIMIT_ID, {
    request,
    rateLimitKey: accountRateLimitKey(kiloUserId),
  });
  if (error === 'not-found') {
    reportMissingRule(USER_RATE_LIMIT_ID);
  }
  return rateLimited;
}
