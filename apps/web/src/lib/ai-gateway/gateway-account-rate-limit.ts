import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';
import type { NextRequest } from 'next/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getAnonymousUserId } from '@/lib/anonymous';
import { validateAuthorizationHeader } from '@/lib/tokens';

/**
 * Vercel Firewall rate limit that caps how much inference one account can ask
 * for. The rule lives in the project's firewall configuration; `checkRateLimit`
 * reports an unknown id as "not rate limited", so the Sentry report below is the
 * only signal that the rule has gone missing.
 */
const GATEWAY_INFERENCE_RATE_LIMIT_ID = 'gateway-inference';

/**
 * A missing rule disables the cap for every request an instance serves, so one
 * report a minute raises the alarm just as well as one per request. Reporting
 * per request floods Sentry at exactly the moment the cap is not working.
 *
 * The throttle is per instance, so a fleet of N instances reports up to N times
 * a minute. That is the ceiling worth paying for a module-level timestamp.
 */
const MISSING_RULE_REPORT_INTERVAL_MS = 60_000;
let lastMissingRuleReportAt = 0;

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
 * Caps the inference request rate of one account across every source address.
 *
 * The WAF rules in front of this route count per IP, so an actor holding a
 * range multiplies its allowance by the number of addresses it rotates
 * through. That is how a flood reached the usage writes behind this route and
 * exhausted the connection pool. Keying on the account instead of the address
 * is what makes address rotation stop paying.
 */
export async function isGatewayAccountRateLimited(
  request: NextRequest,
  accountKey: string
): Promise<boolean> {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!host) {
    throw new Error('Cannot check the gateway rate limit without a host header');
  }

  const { rateLimited, error } = await checkRateLimit(GATEWAY_INFERENCE_RATE_LIMIT_ID, {
    headers: {
      host,
      'x-real-ip': request.headers.get('x-real-ip') ?? '',
      'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
    },
    rateLimitKey: `${GATEWAY_INFERENCE_RATE_LIMIT_ID}:${accountKey}`,
  });

  if (error === 'not-found') {
    const now = Date.now();
    if (now - lastMissingRuleReportAt >= MISSING_RULE_REPORT_INTERVAL_MS) {
      lastMissingRuleReportAt = now;
      captureMessage(`Firewall rate limit '${GATEWAY_INFERENCE_RATE_LIMIT_ID}' is not configured`, {
        level: 'error',
        tags: { source: 'gateway_inference' },
      });
    }
  }

  return rateLimited;
}
