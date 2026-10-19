import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';

/**
 * A limiter that cannot answer affects every request an instance serves, so
 * one report a minute raises the alarm just as well as one per request.
 * Reporting per request would flood Sentry at exactly the moment the limiter
 * is not working.
 *
 * The throttle is per instance and per rule id, so a fleet of N instances
 * reports up to N times a minute for each affected rule. That is the ceiling
 * worth paying for module-level timestamps.
 */
const RATE_LIMIT_REPORT_INTERVAL_MS = 60_000;
const lastReportAt = new Map<string, number>();

function reportRateLimitIssue(rateLimitId: string, source: string, message: string): void {
  const now = Date.now();
  if (now - (lastReportAt.get(rateLimitId) ?? 0) >= RATE_LIMIT_REPORT_INTERVAL_MS) {
    lastReportAt.set(rateLimitId, now);
    captureMessage(message, {
      level: 'error',
      tags: { source },
    });
  }
}

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
    reportRateLimitIssue(
      rateLimitId,
      source,
      `Firewall rate limit '${rateLimitId}' is not configured`
    );
  } else if (error === 'blocked') {
    reportRateLimitIssue(
      rateLimitId,
      source,
      `Firewall rate limit '${rateLimitId}' could not be evaluated`
    );
  }

  if (rateLimited) {
    return 'limited';
  }
  return error ? 'unavailable' : 'allowed';
}

/** Clears the report throttle between tests that share this module instance. */
export const __test__ = {
  resetReportThrottle(): void {
    lastReportAt.clear();
  },
};
