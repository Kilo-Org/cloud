import 'server-only';
import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { callerAddressFromHeaders } from './caller-address';
import { checkFirewallRateLimit } from './firewall-rate-limit';

/**
 * Vercel Firewall rate limits for the native sign-in exchange. The rules live in
 * the project's firewall configuration. Both checks go through the shared
 * check, which reports a rule that is not configured or an answer the firewall
 * blocked through the once-per-rule-per-minute throttle.
 *
 * The address rule runs before the admission gate and proceeds only on `allowed`.
 * The account rule runs once the account is known and takes no refusal decision
 * of its own, so an unconfigured rule and a blocked answer the rule did not
 * limit let the exchange finish. Both rules use source
 * `native_token_rate_limit`.
 */
const ADDRESS_RATE_LIMIT_ID = 'native-token-address';
const USER_RATE_LIMIT_ID = 'native-token-user';

/** The account key counts on an opaque digest, never on the address or id itself. */
function accountRateLimitKey(kiloUserId: string): string {
  const digest = createHmac('sha256', NEXTAUTH_SECRET).update(kiloUserId).digest('base64url');
  return `${USER_RATE_LIMIT_ID}:${digest}`;
}

/**
 * True when one client address is exchanging device credentials too fast.
 * Refuses unless the limiter confirmed the exchange may proceed.
 */
export async function isNativeTokenAddressRateLimited(request: Request): Promise<boolean> {
  const address = callerAddressFromHeaders(request.headers);
  const limit = await checkFirewallRateLimit(ADDRESS_RATE_LIMIT_ID, {
    source: 'native_token_rate_limit',
    request,
    rateLimitKey: `${ADDRESS_RATE_LIMIT_ID}:${address}`,
    blockedMessage: `Firewall rate limit '${ADDRESS_RATE_LIMIT_ID}' did not permit the exchange`,
  });
  return limit !== 'allowed';
}

/**
 * True when one account is exchanging device credentials too fast. The shared
 * check reports a rule that is not configured or an answer the firewall
 * blocked, and only a limited answer refuses the exchange.
 */
export async function isNativeTokenUserRateLimited(
  request: Request,
  kiloUserId: string
): Promise<boolean> {
  const limit = await checkFirewallRateLimit(USER_RATE_LIMIT_ID, {
    source: 'native_token_rate_limit',
    request,
    rateLimitKey: accountRateLimitKey(kiloUserId),
  });
  return limit === 'limited';
}
