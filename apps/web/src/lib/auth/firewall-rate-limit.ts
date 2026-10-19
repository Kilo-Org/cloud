import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';

/**
 * The result of a firewall rate-limit check. `unavailable` means the limiter
 * itself could not be consulted, so the caller returns a refusal instead of
 * proceeding.
 */
export type FirewallRateLimitResult = 'allowed' | 'limited' | 'unavailable';

type CheckOptions = {
  /** Sentry `source` tag identifying the calling branch. */
  source: string;
  /** The request whose headers the firewall evaluates. */
  request?: Request;
  /** Alternative to `request` for callers outside a request scope. */
  headers?: Headers | Record<string, string> | Record<string, string | string[]>;
  /** The key the firewall rule counts against. */
  rateLimitKey?: string;
};

/**
 * Runs one Vercel Firewall rate-limit check and reports a limiter that cannot
 * answer. The rule lives in the project's firewall configuration;
 * `checkRateLimit` resolves an unknown id to "not rate limited", so the Sentry
 * report below is the signal that a rule needs to be created.
 *
 * Callers map `unavailable` to a refusal so that a branch only runs when the
 * limiter has confirmed it may proceed.
 */
export async function checkFirewallRateLimit(
  rateLimitId: string,
  { source, ...options }: CheckOptions
): Promise<FirewallRateLimitResult> {
  const { rateLimited, error } = await checkRateLimit(rateLimitId, options);

  if (error === 'not-found') {
    captureMessage(`Firewall rate limit '${rateLimitId}' is not configured`, {
      level: 'error',
      tags: { source },
    });
  } else if (error === 'blocked') {
    captureMessage(`Firewall rate limit '${rateLimitId}' could not be evaluated`, {
      level: 'error',
      tags: { source },
    });
  }

  if (rateLimited) {
    return 'limited';
  }
  return error ? 'unavailable' : 'allowed';
}
