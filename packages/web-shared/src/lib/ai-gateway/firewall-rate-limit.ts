import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';
import type { NextRequest } from 'next/server';

/**
 * A missing rule disables the cap for every request an instance serves, so one
 * report a minute raises the alarm just as well as one per request. Reporting
 * per request floods Sentry at exactly the moment the cap is not working.
 *
 * The throttle is per instance and per rule, so a fleet of N instances reports
 * up to N times a minute for each missing rule. That is the ceiling worth paying
 * for module-level timestamps.
 */
const MISSING_RULE_REPORT_INTERVAL_MS = 60_000;
const lastMissingRuleReportAt = new Map<string, number>();

type FirewallRateLimitRule = {
  /** Rate limit ID of the `@vercel/firewall` rule in the project's firewall configuration. */
  id: string;
  /** Bucket the request counts against. */
  key: string;
  /** Sentry `source` tag for the missing-rule report. */
  sentrySource: string;
};

/**
 * Counts the request against a Vercel Firewall rate limit rule.
 *
 * `checkRateLimit` reports an unknown rule id as "not rate limited", so the
 * Sentry report below is the only signal that the rule has gone missing.
 *
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

  const { rateLimited, error } = await checkRateLimit(rule.id, {
    headers: {
      host,
      'x-real-ip': request.headers.get('x-real-ip') ?? '',
      'x-forwarded-for': request.headers.get('x-forwarded-for') ?? '',
    },
    rateLimitKey: `${rule.id}:${rule.key}`,
  });

  if (error === 'not-found') {
    const now = Date.now();
    if (now - (lastMissingRuleReportAt.get(rule.id) ?? 0) >= MISSING_RULE_REPORT_INTERVAL_MS) {
      lastMissingRuleReportAt.set(rule.id, now);
      captureMessage(`Firewall rate limit '${rule.id}' is not configured`, {
        level: 'error',
        tags: { source: rule.sentrySource },
      });
    }
  }

  return rateLimited;
}
