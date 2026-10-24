import 'server-only';
import type { NextRequest } from 'next/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getAnonymousUserId } from '@kilocode/web-shared/lib/anonymous';
import { validateAuthorizationHeader } from '@kilocode/web-shared/lib/tokens';
import { checkFirewallRateLimit } from '@kilocode/web-shared/lib/ai-gateway/firewall-rate-limit';

/**
 * Vercel Firewall rate limit that caps how much inference one account can ask
 * for. The rule lives in the project's firewall configuration.
 */
const GATEWAY_INFERENCE_RATE_LIMIT_ID = 'gateway-inference';

/**
 * Builds the key the inference cap counts on, without a database query.
 *
 * The route has to cap before it resolves the account, because resolving the
 * account reads the database and that read is the cost the cap exists to avoid.
 * The bearer token already carries a signed `kiloUserId`, so the key comes from
 * the token instead of from the user row.
 *
 * `validateAuthorizationHeader` verifies the signature, so a caller cannot pick
 * its own key by editing the claim. A token that fails validation counts as the
 * address, which matches how the route bills a failed auth.
 */
export function gatewayRateLimitKey(headers: Headers, ipAddress: string | undefined): string {
  if (!headers.get('authorization')) {
    return getAnonymousUserId(ipAddress ?? '');
  }

  // `runtimeProxyAttestationVerified` gates only the extra attestation bound to
  // cloud-agent tokens. Counting is not authorization and the signature is
  // verified either way, so those tokens count as their own account here rather
  // than collapsing onto a shared egress address.
  const validated = validateAuthorizationHeader(headers, {
    expectedAudience: KILO_GATEWAY_AUDIENCE,
    runtimeProxyAttestationVerified: true,
  });

  return 'kiloUserId' in validated && typeof validated.kiloUserId === 'string'
    ? validated.kiloUserId
    : getAnonymousUserId(ipAddress ?? '');
}

/**
 * Account admission verdict. Callers distinguish server errors from throttling.
 */
export type GatewayRateLimitOutcome = 'admitted' | 'rate-limited' | 'unavailable';

/**
 * Caps the inference request rate of one account across every source address.
 *
 * The WAF rules in front of this route count per IP, so an actor holding a
 * range multiplies its allowance by the number of addresses it rotates
 * through. That is how a flood reached the usage writes behind this route and
 * exhausted the connection pool. Keying on the account instead of the address
 * is what makes address rotation stop paying.
 *
 * This is an admission control, so it fails closed. When the rule is absent the
 * cap cannot be enforced, and the caller refuses the request rather than
 * serving traffic without it. The throttled missing-rule report asks an
 * operator to restore the rule.
 */
export async function checkGatewayAccountRateLimit(
  request: NextRequest,
  accountKey: string
): Promise<GatewayRateLimitOutcome> {
  const verdict = await checkFirewallRateLimit(request, {
    id: GATEWAY_INFERENCE_RATE_LIMIT_ID,
    key: accountKey,
    sentrySource: 'gateway_inference',
  });

  if (verdict === 'rule-missing') {
    return 'unavailable';
  }
  return verdict === 'limited' ? 'rate-limited' : 'admitted';
}
