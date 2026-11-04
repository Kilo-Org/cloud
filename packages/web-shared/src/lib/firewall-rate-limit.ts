import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';

const RATE_LIMIT_DEADLINE_MS = 300;
const RATE_LIMIT_REPORT_INTERVAL_MS = 60_000;
// Per-instance, per-rule throttling prevents a limiter outage from flooding Sentry.
const lastReportAt = new Map<string, number>();

export function reportFirewallRateLimitIssue(
  rateLimitId: string,
  source: string,
  message: string
): void {
  const now = Date.now();
  const previous = lastReportAt.get(rateLimitId);
  if (previous === undefined || now - previous >= RATE_LIMIT_REPORT_INTERVAL_MS) {
    lastReportAt.set(rateLimitId, now);
    captureMessage(message, {
      level: 'error',
      tags: { source },
    });
  }
}

export type FirewallRateLimitResult = 'allowed' | 'limited' | 'unavailable';

type CheckOptions = {
  source: string;
  request?: Request;
  headers?: Headers | Record<string, string> | Record<string, string | string[]>;
  rateLimitKey?: string;
};

export async function checkFirewallRateLimit(
  rateLimitId: string,
  { source, ...options }: CheckOptions
): Promise<FirewallRateLimitResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<ReturnType<typeof checkRateLimit>> | 'timeout' | 'error';
  try {
    // @vercel/firewall does not accept an abort signal, so only our wait can be bounded.
    result = await Promise.race([
      checkRateLimit(rateLimitId, options),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), RATE_LIMIT_DEADLINE_MS);
      }),
    ]);
  } catch {
    result = 'error';
  } finally {
    clearTimeout(timer);
  }

  if (typeof result === 'string' || result.error) {
    const reason = typeof result === 'string' ? result : result.error;
    reportFirewallRateLimitIssue(
      rateLimitId,
      source,
      reason === 'not-found'
        ? `Firewall rate limit '${rateLimitId}' is not configured`
        : reason === 'timeout'
          ? `Firewall rate limit '${rateLimitId}' timed out`
          : `Firewall rate limit '${rateLimitId}' could not be evaluated`
    );
    return 'unavailable';
  }

  return result.rateLimited ? 'limited' : 'allowed';
}

export const __test__ = {
  resetReportThrottle(): void {
    lastReportAt.clear();
  },
};
