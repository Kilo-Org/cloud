import 'server-only';

import { isIP } from 'net';

import { after, NextResponse, type NextRequest } from 'next/server';

import { isCloudflareIP } from '@kilocode/web-shared/lib/cloudflare-ip';
import {
  isUserRateLimitedFeature,
  type FeatureValue,
} from '@kilocode/web-shared/lib/feature-detection';
import {
  decide,
  releaseDecideLease,
  type DecideResponse,
  type DecideTier,
} from '@kilocode/web-shared/lib/bouncer/client';
import type { OrganizationPlan } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { BalancePayer } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

/**
 * The gateway awaits decide immediately before the upstream call, so this bounds the latency it
 * can add. A slower verdict resolves to null and the request is sent.
 */
export const BOUNCER_DECIDE_TIMEOUT_MS = 500;

const logBouncerVerdict = sentryLogger('bouncer', 'info');

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

export type BouncerDecideParams = {
  requestId: string;
  ip: string | undefined;
  /** Normalized client-fingerprint digest, when the request carried a valid header. */
  ja4?: string | undefined;
  account?: {
    accountId: string;
    tier: Exclude<DecideTier, 'anonymous'>;
    /** The paying user's or organization's row, as the balance check read it. */
    payer?: BalancePayer;
  };
};

/**
 * Starts the one `decide` for this request and returns its verdict; await it immediately before
 * the upstream call. The verdict is null on a timeout, any error, a rejected `params` promise, or
 * an unknown verdict shape, and never rejects.
 *
 * An `after()` callback keeps the decide alive across an early return. Next runs it once the
 * response has closed, including a streamed body, so the request is no longer in flight; it then
 * releases a spend-watched account's concurrency lease on every path. A usage event for the same
 * request releases it too; release is idempotent, so either order is harmless.
 */
export function startBouncerDecide(
  params: BouncerDecideParams | Promise<BouncerDecideParams>
): Promise<DecideResponse | null> {
  const resolvedParams = Promise.resolve(params);
  const verdict = resolvedParams
    .then(({ requestId, ip, ja4, account }) => {
      if (account) {
        return decide(
          {
            requestId,
            tier: account.tier,
            accountId: account.accountId,
            ip,
            ja4,
            accountCreatedAt: account.payer?.createdAt,
            usedMicrodollars: account.payer?.microdollarsUsed,
            acquiredMicrodollars: account.payer?.totalMicrodollarsAcquired,
          },
          { timeoutMs: BOUNCER_DECIDE_TIMEOUT_MS }
        );
      }
      // Anonymous verdicts are keyed on the IP; without one there is nothing to ask.
      if (ip === undefined) return null;
      return decide(
        { requestId, tier: 'anonymous', ip, ja4 },
        { timeoutMs: BOUNCER_DECIDE_TIMEOUT_MS }
      );
    })
    .catch(() => null);
  // A callback, not a promise: Next runs it after the response closes.
  after(async () => {
    if ((await verdict)?.spendWatch !== true) return;
    const decided = await resolvedParams.catch(() => null);
    if (!decided?.account) return;
    await releaseDecideLease({
      requestId: decided.requestId,
      accountId: decided.account.accountId,
    });
  });
  return verdict;
}

/**
 * Maps a verdict to the gateway's rejection, or null to send the request upstream. Only
 * `enforced === true` rejects: a throttle code becomes a 429 with `retry-after` (ceil seconds) and
 * `retry-after-ms`, and `restricted` becomes a 403. Flags are internal: they are logged here and
 * never reach the client response.
 */
export function bouncerRejectionResponse(
  verdict: DecideResponse | null,
  requestId: string
): NextResponse | null {
  if (!verdict) return null;
  const rejects = verdict.enforced === true && verdict.code !== undefined;
  // Bouncer already logs every verdict with its flags; the gateway logs only the rejections it
  // applies, so shadow flags on most requests do not multiply the log volume.
  if (rejects) {
    logBouncerVerdict('[bouncer] decide verdict', {
      requestId,
      enforced: verdict.enforced,
      code: verdict.code,
      retryAfterMs: verdict.retryAfterMs,
      flags: verdict.flags,
    });
  }
  if (!rejects) return null;
  if (verdict.code === 'restricted') {
    return NextResponse.json(
      {
        error: 'Request not allowed',
        error_type: ProxyErrorType.account_restricted,
        message: 'This account cannot make requests right now. Contact support.',
      },
      { status: 403 }
    );
  }
  const headers = new Headers();
  if (verdict.retryAfterMs !== undefined) {
    const retryAfterMs = Math.ceil(verdict.retryAfterMs);
    headers.set('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    headers.set('retry-after-ms', String(retryAfterMs));
  }
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      error_type: ProxyErrorType.rate_limit_exceeded,
      message: 'Too many requests. Please try again later.',
    },
    { status: 429, headers }
  );
}
