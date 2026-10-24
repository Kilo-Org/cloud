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

/**
 * Outcome of a firewall rate-limit check.
 *
 * `rule-missing` means the rule id is absent from the project's firewall
 * configuration. `checkRateLimit` answers HTTP 404 with `rateLimited: false` for
 * that case, so it has to be a verdict of its own rather than an admitted
 * request: only the caller knows whether the traffic it guards may proceed
 * without the cap. A cap that guards admission must treat `rule-missing` as a
 * refusal.
 */
export type FirewallRateLimitVerdict = 'allowed' | 'limited' | 'rule-missing';

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
 * Only the host and address headers are passed on: `checkRateLimit` copies
 * every header it is given onto its own request, and inference requests carry
 * the caller's credentials.
 */
export async function checkFirewallRateLimit(
  request: NextRequest,
  rule: FirewallRateLimitRule
): Promise<FirewallRateLimitVerdict> {
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
    return 'rule-missing';
  }

  return rateLimited ? 'limited' : 'allowed';
}
