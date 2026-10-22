/**
 * Server-side request forgery (SSRF) guard for AI gateway upstream requests.
 *
 * Custom LLM definitions carry their own upstream URLs. Without this guard a
 * URL such as `https://169.254.169.254/...` (cloud metadata) or
 * `https://localhost:3000/...` would make the gateway send a request into an
 * internal network and stream the response back to the caller. Plain HTTP
 * would also expose API keys and prompts to anyone on the network path.
 */
import { lookup } from 'node:dns/promises';
import { captureMessage } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { isIpAddress, isPublicIp } from './ip-address';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { withRequestId } from '@kilocode/web-shared/lib/ai-gateway/request-id';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type UpstreamUrlViolation =
  | 'invalid_url'
  | 'non_https'
  | 'non_public_host'
  | 'dns_lookup_failed'
  | 'non_public_address';

type UpstreamUrlRejection = UpstreamUrlViolation | 'redirect';

export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

const PUBLIC_HOSTNAME_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_HOSTNAME_CACHE_MAX_ENTRIES = 1000;
const DNS_LOOKUP_ATTEMPTS = 2;
const DNS_RETRY_DELAY_MS = 100;
const DNS_LOOKUP_TIMEOUT_MS = 2_000;
const publicHostnameExpiresAt = new Map<string, number>();

const REJECTION_MESSAGES = {
  invalid_url: 'The upstream provider URL is not a valid URL.',
  non_https: 'The upstream provider URL is not allowed because it does not use HTTPS.',
  non_public_host: 'The upstream provider URL is not allowed because its host is not public.',
  non_public_address:
    'The upstream provider URL is not allowed because its host resolves to a non-public address.',
  dns_lookup_failed:
    'The gateway could not resolve the upstream provider host. This may be temporary; try again shortly.',
  redirect: 'The upstream provider responded with a redirect, which the gateway does not follow.',
} as const satisfies Record<UpstreamUrlRejection, string>;

/**
 * Enforced on the deployed production and staging gateways. Local development
 * reaches the fake LLM over plain HTTP on localhost, so it stays exempt.
 * `NODE_ENV` is `production` on previews too, so it cannot be used here.
 */
export function isUpstreamUrlPolicyEnforced(): boolean {
  const targetEnv = process.env.VERCEL_TARGET_ENV;
  return targetEnv === 'production' || targetEnv === 'staging';
}

async function resolveWithSystemResolver(hostname: string): Promise<string[]> {
  // The same getaddrinfo resolver fetch uses, so /etc/hosts entries are seen too.
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid_url';
  }
}

function isCachedPublicHostname(hostname: string, now: number): boolean {
  const expiresAt = publicHostnameExpiresAt.get(hostname);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  publicHostnameExpiresAt.delete(hostname);
  return false;
}

function cachePublicHostname(hostname: string, now: number): void {
  if (publicHostnameExpiresAt.size >= PUBLIC_HOSTNAME_CACHE_MAX_ENTRIES) {
    publicHostnameExpiresAt.clear();
  }
  publicHostnameExpiresAt.set(hostname, now + PUBLIC_HOSTNAME_CACHE_TTL_MS);
}

/**
 * Settles with `promise`, or rejects with the abort reason as soon as `signal`
 * aborts. `dns.lookup` cannot be cancelled, so a stalled getaddrinfo keeps its
 * thread-pool slot, but the request no longer waits for it.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * One retry absorbs a transient resolver failure such as `EAI_AGAIN`. Each
 * attempt has its own deadline, so a stalled resolver ends in
 * `dns_lookup_failed` within about two deadlines instead of holding the
 * request. An abort of `signal` (client disconnect or the request budget)
 * rejects at once with its reason.
 */
async function resolveWithRetry(
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal: AbortSignal | undefined
): Promise<string[] | null> {
  for (let attempt = 0; attempt < DNS_LOOKUP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const delay = new Promise(resolve => setTimeout(resolve, DNS_RETRY_DELAY_MS));
      await (signal ? untilAborted(delay, signal) : delay);
    }
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(DNS_LOOKUP_TIMEOUT_MS);
    try {
      const addresses = await untilAborted(
        resolveHostAddresses(hostname),
        signal ? AbortSignal.any([signal, deadline]) : deadline
      );
      if (addresses.length > 0) return addresses;
    } catch {
      if (signal?.aborted) throw signal.reason;
      // A failed or timed-out attempt is retried; the caller reports
      // dns_lookup_failed once attempts run out.
    }
  }
  return null;
}

export function clearUpstreamUrlPolicyCache(): void {
  publicHostnameExpiresAt.clear();
}

/**
 * Checks that an upstream URL uses HTTPS and that its host, and every address
 * it resolves to, is publicly routable. The fetch resolves the name again, so
 * this does not stop DNS rebinding.
 *
 * Rejects with the abort reason when `signal` aborts during the DNS lookup.
 */
export async function findUpstreamUrlViolation(
  value: string,
  {
    resolveHostAddresses = resolveWithSystemResolver,
    signal,
  }: { resolveHostAddresses?: ResolveHostAddresses; signal?: AbortSignal } = {}
): Promise<UpstreamUrlViolation | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_url';
  }

  if (url.protocol !== 'https:') return 'non_https';

  const hostname = normalizeHostname(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'non_public_host';

  // WHATWG URL parsing already canonicalizes obfuscated literals such as
  // `2130706433` or `0x7f.1` to `127.0.0.1`, so they cannot slip past here.
  if (isIpAddress(hostname)) {
    return isPublicIp(hostname) ? null : 'non_public_host';
  }

  const now = Date.now();
  if (isCachedPublicHostname(hostname, now)) return null;

  // A public-looking name can still point at a private address, for example
  // `metadata.attacker.example` with an A record of 169.254.169.254.
  const addresses = await resolveWithRetry(hostname, resolveHostAddresses, signal);
  if (!addresses) return 'dns_lookup_failed';
  if (addresses.some(address => !isPublicIp(address))) return 'non_public_address';

  cachePublicHostname(hostname, now);
  return null;
}

function rejectionResponse({
  rejection,
  host,
  providerId,
  vercelRequestId,
}: {
  rejection: UpstreamUrlRejection;
  host: string;
  providerId: string;
  vercelRequestId: string | null | undefined;
}): NextResponse {
  const transient = rejection === 'dns_lookup_failed';
  const metadata = {
    providerId,
    targetHost: host,
    violation: rejection,
    ...(vercelRequestId && { vercelRequestId }),
  };
  errorExceptInTest('AI gateway upstream URL rejected', metadata);
  captureMessage('AI gateway upstream URL rejected', {
    level: transient ? 'warning' : 'error',
    tags: {
      source: 'ai-gateway-upstream-url-policy',
      provider: providerId,
      violation: rejection,
    },
    extra: metadata,
  });

  const error = withRequestId(REJECTION_MESSAGES[rejection], vercelRequestId);
  return NextResponse.json(
    {
      error,
      error_type: transient
        ? ProxyErrorType.temporarily_unavailable
        : ProxyErrorType.upstream_error,
      message: error,
      ...(vercelRequestId && { vercel_request_id: vercelRequestId }),
    },
    { status: transient ? 503 : 502 }
  );
}

/**
 * Returns the error response for the first URL that violates the policy, or
 * null. Rejects with the abort reason when `signal` aborts, exactly like the
 * upstream fetch would, so the caller's fetch-failure handling applies.
 */
export async function rejectDisallowedUpstreamUrls({
  urls,
  providerId,
  vercelRequestId,
  signal,
}: {
  urls: string[];
  providerId: string;
  vercelRequestId: string | null | undefined;
  signal: AbortSignal;
}): Promise<NextResponse | null> {
  const violations = await Promise.all(urls.map(url => findUpstreamUrlViolation(url, { signal })));
  const index = violations.findIndex(violation => violation !== null);
  const violation = violations[index];
  if (!violation) return null;
  return rejectionResponse({
    rejection: violation,
    host: hostOf(urls[index]),
    providerId,
    vercelRequestId,
  });
}

/**
 * Upstream fetches use `redirect: 'manual'` while the policy is enforced: an
 * allowed public host could otherwise answer with a 307 to an internal
 * address and the fetch would follow it without the policy ever seeing it.
 * This turns such a redirect into an error instead of streaming it as success.
 */
export async function rejectUpstreamRedirect({
  response,
  url,
  providerId,
  vercelRequestId,
}: {
  response: Response;
  url: string;
  providerId: string;
  vercelRequestId: string | null | undefined;
}): Promise<NextResponse | null> {
  if (response.status < 300 || response.status >= 400) return null;
  await response.body?.cancel().catch(() => undefined);
  return rejectionResponse({
    rejection: 'redirect',
    host: hostOf(url),
    providerId,
    vercelRequestId,
  });
}
