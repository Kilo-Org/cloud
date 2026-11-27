import {
  UTS_FEED_AUDIENCE,
  UTS_FEED_READ_SCOPE,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { createVerifier, failureResponse, httpJwksSource, type Verifier } from '@kilocode/verify';
import type { FeedConfig } from './env';

/**
 * The caller check of the HTTPS feed (design 5.6): every head, list and bootstrap request carries
 * an STS service token for audience `uts-feed` and scope `uts-feed:revocation.read`, which
 * `@kilocode/verify` checks against the STS key set, and the token's workload must be one this
 * environment admits (`UTS_FEED_HTTPS_WORKLOADS`). Nothing is read from a feed object before the
 * check passes.
 */

/** The wait a caller is asked for while the HTTPS feed is off or has no STS issuer. */
export const FEED_HTTPS_OFF_RETRY_SECONDS = 60;

export type FeedAdmission =
  | { status: 'admitted'; workload: string }
  | { status: 'refused'; response: Response };

/** One verifier per isolate, for the issuer and environment it was made for, so its key-set cache serves every request. */
let held: { key: string; verifier: Verifier<false> } | null = null;

function verifierFor(
  stsIssuer: string,
  environment: UtsEnvironment,
  feedOrigin: string
): Verifier<false> {
  const key = `${stsIssuer}|${environment}|${feedOrigin}`;
  if (held?.key !== key) {
    held = {
      key,
      verifier: createVerifier({
        audience: UTS_FEED_AUDIENCE,
        environment,
        // Sent only in 401 challenges; the feed names no user resource.
        resourceMetadataUrl: `${feedOrigin}/.well-known/oauth-protected-resource`,
        sts: {
          issuer: stsIssuer,
          jwks: httpJwksSource(stsIssuer),
          // The feed's own scope; STS mints it only for the workloads its policy lists.
          scopeRegistry: { [UTS_FEED_AUDIENCE]: { scopes: [UTS_FEED_READ_SCOPE] } },
        },
      }),
    };
  }
  return held.verifier;
}

/** Drops the isolate's verifier; tests only. */
export function resetFeedVerifier(): void {
  held = null;
}

function refusal(
  error: string,
  status: number,
  headers: Record<string, string> = {}
): FeedAdmission {
  return {
    status: 'refused',
    response: Response.json(
      { error },
      { status, headers: { 'Cache-Control': 'no-store', ...headers } }
    ),
  };
}

export async function admitFeedRequest(
  request: Request,
  config: FeedConfig,
  ctx: ExecutionContext
): Promise<FeedAdmission> {
  const { https } = config;
  if (https.status !== 'on') {
    if (https.status === 'unconfigured') {
      console.warn(JSON.stringify({ event: 'uts_feed.https.unconfigured' }));
    }
    return refusal('temporarily_unavailable', 503, {
      'Retry-After': String(FEED_HTTPS_OFF_RETRY_SECONDS),
    });
  }
  const verifier = verifierFor(https.stsIssuer, config.environment, config.endpoints.feedOrigin);
  const result = await verifier.verify(
    request,
    { issuer: 'sts', scope: UTS_FEED_READ_SCOPE },
    { waitUntil: promise => ctx.waitUntil(promise) }
  );
  if (!result.ok) {
    console.warn(JSON.stringify({ event: 'uts_feed.https.refused', reason: result.reason }));
    return { status: 'refused', response: failureResponse(result) };
  }
  // A verified STS token always names a service; a user or PAT caller cannot reach this point.
  const workload = result.caller.kind === 'service' ? result.caller.workload : null;
  if (workload === null || !https.workloads.includes(workload)) {
    console.warn(JSON.stringify({ event: 'uts_feed.https.refused', reason: 'workload', workload }));
    return refusal('access_denied', 403);
  }
  return { status: 'admitted', workload };
}
