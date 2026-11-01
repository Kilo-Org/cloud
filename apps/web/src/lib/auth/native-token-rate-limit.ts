import 'server-only';
import { checkRateLimit } from '@vercel/firewall';
import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { reportFirewallRateLimitIssue } from './firewall-rate-limit';

/**
 * Vercel Firewall rate limits for the native sign-in exchange. The rules live in
 * the project's firewall configuration, so `checkRateLimit` answers `not-found`
 * for an id that is not configured there and this module reports that answer
 * once a minute per rule.
 *
 * The address rule runs before the admission gate, so one client address cannot
 * spend the provider calls that admission and identity verification make: the
 * exchange proceeds only on an answer that permits it. The account rule runs
 * once the account is known, before any device session or refresh token is
 * written; it reports a rule that is not configured and lets the exchange
 * finish, because the provider calls it covers have already happened by then.
 */
const ADDRESS_RATE_LIMIT_ID = 'native-token-address';
const USER_RATE_LIMIT_ID = 'native-token-user';

/** The account key counts on an opaque digest, never on the address or id itself. */
function accountRateLimitKey(kiloUserId: string): string {
  const digest = createHmac('sha256', NEXTAUTH_SECRET).update(kiloUserId).digest('base64url');
  return `${USER_RATE_LIMIT_ID}:${digest}`;
}

function reportMissingRule(rateLimitId: string): void {
  reportFirewallRateLimitIssue(
    rateLimitId,
    'native_token_rate_limit',
    `Firewall rate limit '${rateLimitId}' is not configured`
  );
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
  // A rule that is not configured cannot permit the exchange, so a request is
  // only let through once the limiter has confirmed it may proceed.
  if (error === 'not-found') {
    reportMissingRule(ADDRESS_RATE_LIMIT_ID);
    return true;
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
