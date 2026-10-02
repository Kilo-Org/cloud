import 'server-only';

import { isIP } from 'net';

import { after, type NextRequest } from 'next/server';

import { isCloudflareIP } from '@/lib/cloudflare-ip';
import { isUserRateLimitedFeature, type FeatureValue } from '@/lib/feature-detection';
import { decide, type DecideTier, type DecideVerdict } from '@/lib/bouncer/client';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';

/** Report-only decide runs in `after()` and never holds up the upstream request. */
export const BOUNCER_DECIDE_TIMEOUT_MS = 30_000;

/**
 * The request's client address, read once from the platform's trusted boundary.
 * The gateway runs behind a proxy that sets `x-forwarded-for`, so only the first
 * hop can be the caller; later hops are proxies. Returns the raw value, which
 * may still carry a port, brackets, or a scope id.
 */
export function rawClientIp(request: NextRequest): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || undefined;
}

/**
 * Bouncer's typia types accept a bare IPv4/IPv6 literal only. `x-forwarded-for`
 * can carry an IPv6 bracket, a port, or a value that is not an address at all,
 * so drop the wrapper and return `undefined` unless a literal remains.
 */
export function bareIpLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  const ipv4WithPort = /^([^:]+):\d+$/.exec(value);
  const candidate = bracketed?.[1] ?? ipv4WithPort?.[1] ?? value;
  // A scope id passes `isIP`, and bouncer's typia format rejects it. Drop it rather
  // than send a value that fails the whole event.
  if (candidate.includes('%')) {
    return undefined;
  }
  return isIP(candidate) ? candidate : undefined;
}

/**
 * The signed-in IP to record where bouncer keys a payer (the usage ledger).
 * Shared Kilo infrastructure is dropped here.
 *
 * The server-side Kilo products (cloud-agent, code-review, app-builder, gastown)
 * reach the gateway from Cloudflare Workers, so the first forwarded hop is a
 * Cloudflare address shared by many unrelated requests. Recording it for payer
 * sharing would let one account's traffic trip another payer's IP signal. No
 * trusted forwarding header proves the original client address on those
 * requests, so the address is dropped rather than guessed.
 *
 * Pass the value of {@link bareIpLiteral}, not the raw header.
 */
export function payerSharingIp(
  ip: string | undefined,
  feature: FeatureValue | null
): string | undefined {
  if (ip !== undefined && isUserRateLimitedFeature(feature) && isCloudflareIP(ip)) {
    return undefined;
  }
  return ip;
}

/** Bouncer's tier for a signed-in request, from its organization plan and balance. */
export function bouncerDecideTier(
  organizationId: string | undefined,
  plan: OrganizationPlan | undefined,
  balance: number
): Exclude<DecideTier, 'anonymous'> {
  return organizationId && (plan === 'teams' || plan === 'enterprise')
    ? 'team'
    : balance > 0
      ? 'paid'
      : 'free';
}

/**
 * One report-only `decide`. Resolves to `null` on a timeout or any error (the
 * client never rejects), so callers never need to catch it.
 */
export function bouncerDecide(params: {
  requestId: string;
  ip: string | undefined;
  /** Normalized client-fingerprint digest, when the request carried a valid header. */
  ja4?: string | undefined;
  account?: { accountId: string; tier: Exclude<DecideTier, 'anonymous'> };
}): Promise<DecideVerdict | null> {
  const { requestId, ip, ja4, account } = params;
  if (account) {
    return decide(
      { requestId, tier: account.tier, accountId: account.accountId, ip, ja4 },
      { timeoutMs: BOUNCER_DECIDE_TIMEOUT_MS }
    );
  }
  // Anonymous verdicts are keyed on the IP; without one there is nothing to ask.
  if (ip === undefined) return Promise.resolve(null);
  return decide(
    { requestId, tier: 'anonymous', ip, ja4 },
    { timeoutMs: BOUNCER_DECIDE_TIMEOUT_MS }
  );
}

/**
 * Starts the report-only decide and registers it with `after()`, so an early
 * return does not end its lifetime and the caller never awaits it. The promise
 * never rejects.
 */
export function scheduleBouncerDecide(params: {
  requestId: string;
  ip: string | undefined;
  /** Normalized client-fingerprint digest, when the request carried a valid header. */
  ja4?: string | undefined;
  account?: { accountId: string; tier: Exclude<DecideTier, 'anonymous'> };
}): void {
  after(
    bouncerDecide(params).then(
      () => undefined,
      () => undefined
    )
  );
}
