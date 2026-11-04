import 'server-only';
import { checkFirewallRateLimit } from '@kilocode/web-shared/lib/firewall-rate-limit';
import type { NextRequest } from 'next/server';

type FirewallRateLimitRule = {
  id: string;
  key: string;
  sentrySource: string;
};

/**
 * Only the host and address headers are passed on: `checkRateLimit` copies
 * every header it is given onto its own request, and inference requests carry
 * the caller's credentials.
 */
export async function isFirewallRateLimited(
  request: NextRequest,
  rule: FirewallRateLimitRule
): Promise<boolean> {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!host) {
    throw new Error(`Cannot check the '${rule.id}' rate limit without a host header`);
  }

  const result = await checkFirewallRateLimit(rule.id, {
    source: rule.sentrySource,
    headers: {
      host,
      'x-real-ip': request.headers.get('x-real-ip') ?? '',
      'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
    },
    rateLimitKey: `${rule.id}:${rule.key}`,
  });

  // These abuse caps supplement WAF rules; a reported limiter outage must not stop inference.
  return result === 'limited';
}
