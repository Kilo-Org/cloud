import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';
import type { NextRequest } from 'next/server';

/**
 * Vercel Firewall rate limit that caps how much inference one account can ask
 * for. The rule lives in the project's firewall configuration; `checkRateLimit`
 * reports an unknown id as "not rate limited", so the Sentry report below is the
 * only signal that the rule has gone missing.
 */
const GATEWAY_INFERENCE_RATE_LIMIT_ID = 'gateway-inference';

/**
 * Caps the inference request rate of one account across every source address.
 *
 * The WAF rules in front of this route count per IP, so an actor holding a
 * range multiplies its allowance by the number of addresses it rotates
 * through. That is how a flood reached the usage writes behind this route and
 * exhausted the connection pool. Keying on the account instead of the address
 * is what makes address rotation stop paying.
 *
 * `user.id` is the key for an authenticated account and `anon:{ip}` for an
 * anonymous one, so one call covers both.
 */
export async function isGatewayAccountRateLimited(
  request: NextRequest,
  userId: string
): Promise<boolean> {
  const { rateLimited, error } = await checkRateLimit(GATEWAY_INFERENCE_RATE_LIMIT_ID, {
    request,
    rateLimitKey: `${GATEWAY_INFERENCE_RATE_LIMIT_ID}:${userId}`,
  });

  if (error === 'not-found') {
    captureMessage(`Firewall rate limit '${GATEWAY_INFERENCE_RATE_LIMIT_ID}' is not configured`, {
      level: 'error',
      tags: { source: 'gateway_inference' },
    });
  }

  return rateLimited;
}
