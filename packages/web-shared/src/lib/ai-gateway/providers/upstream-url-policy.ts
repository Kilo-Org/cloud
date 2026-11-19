/**
 * Server-side request forgery (SSRF) guard for AI gateway upstream requests.
 *
 * Custom LLM definitions carry their own upstream URLs. Without this guard a
 * URL such as `https://169.254.169.254/...` (cloud metadata) or
 * `https://localhost:3000/...` would make the gateway send a request into an
 * internal network and stream the response back to the caller. Plain HTTP
 * would also expose API keys and prompts to anyone on the network path.
 */
import { Resolver } from 'node:dns/promises';
import { captureMessage } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { isIpAddress, isPublicIp } from './ip-address';
import { normalizeUpstreamHostname } from './upstream-hostname';
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

/**
 * Resolves `hostname` to its addresses. It should stop as soon as `signal`
 * aborts; the policy stops waiting for it then either way.
 */
export type ResolveHostAddresses = (hostname: string, signal: AbortSignal) => Promise<string[]>;

/**
 * The policy's answer for one upstream URL. An allowed decision names the
 * addresses the caller may dial for that host, and until when they count as
 * checked: the caller pins them into its connection, so a later connection uses
 * them instead of resolving the name again.
 */
export type UpstreamUrlDecision =
  | { allowed: true; hostname: string; addresses: string[]; expiresAt: number }
  | { allowed: false; violation: UpstreamUrlViolation };

const UPSTREAM_ADDRESS_CACHE_TTL_MS = 60 * 1000;
const UPSTREAM_ADDRESS_CACHE_MAX_ENTRIES = 1000;
/** c-ares waits this long for the first answer and doubles it for each retry. */
const DNS_QUERY_TIMEOUT_MS = 1_000;
const DNS_QUERY_TRIES = 2;
/** Caps one validation's resolution, including the retry below. */
const DNS_LOOKUP_DEADLINE_MS = 5_000;
const DNS_LOOKUP_ATTEMPTS = 2;
const DNS_RETRY_DELAY_MS = 100;
/** Definitive answers that a retry would only repeat. */
const DNS_NO_RECORDS_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * The checked address list per normalized hostname. It is the list an allowed
 * decision carries, so a cache hit returns the addresses the first check
 * approved instead of asking the resolver again.
 */
const checkedUpstreamAddresses = new Map<string, { addresses: string[]; expiresAt: number }>();

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
 * Enforced everywhere except local development and tests, so a deployment whose
 * environment labels are missing or new still gets the guard. Local development
 * reaches the fake LLM over plain HTTP on localhost. Next.js inlines `NODE_ENV`
 * at build time, so every built deployment, previews included, enforces it.
 */
export function isUpstreamUrlPolicyEnforced(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/**
 * Asks the DNS servers from the system configuration for the A and AAAA records
 * of `hostname`, with c-ares. Unlike `dns.lookup`, it does not hold a libuv
 * threadpool worker and it can be cancelled, so a slow upstream DNS server
 * cannot hold up resolution for other hosts. It skips `/etc/hosts`, which an
 * SSRF guard has no reason to trust.
 *
 * Either family may be missing; the answer holds every address found. It
 * rejects only when neither family answered an address.
 */
async function resolveWithSystemResolver(hostname: string, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: DNS_QUERY_TIMEOUT_MS, tries: DNS_QUERY_TRIES });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses = answers.flatMap(answer =>
      answer.status === 'fulfilled' ? answer.value : []
    );
    if (addresses.length > 0) return addresses;
    const failures = answers.flatMap(answer =>
      answer.status === 'rejected' ? [answer.reason as unknown] : []
    );
    // Report a transient failure over a definitive "no records", so it is retried.
    throw (
      failures.find(failure => !DNS_NO_RECORDS_CODES.has(errorCode(failure) ?? '')) ??
      failures[0] ??
      Object.assign(new Error(`no address records for ${hostname}`), { code: 'ENODATA' })
    );
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid_url';
  }
}

/**
 * The checked entry for `hostname`, or null when the entry is missing or
 * expired. The address list is a copy, so a caller that stores or edits the
 * list it receives cannot change what later checks return. An expired entry is
 * dropped here.
 */
function cachedUpstreamAddresses(
  hostname: string,
  now: number
): { addresses: string[]; expiresAt: number } | null {
  const entry = checkedUpstreamAddresses.get(hostname);
  if (entry === undefined) return null;
  if (entry.expiresAt > now) return { addresses: [...entry.addresses], expiresAt: entry.expiresAt };
  checkedUpstreamAddresses.delete(hostname);
  return null;
}

function cacheUpstreamAddresses(hostname: string, addresses: string[], expiresAt: number): void {
  if (checkedUpstreamAddresses.size >= UPSTREAM_ADDRESS_CACHE_MAX_ENTRIES) {
    checkedUpstreamAddresses.clear();
  }
  checkedUpstreamAddresses.set(hostname, { addresses: [...addresses], expiresAt });
}

/**
 * Settles with `promise`, or rejects with the abort reason as soon as `signal`
 * aborts, even when the resolver ignores the signal.
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
 * Resolves `hostname` within `DNS_LOOKUP_DEADLINE_MS`. One retry absorbs a
 * transient failure such as SERVFAIL; a definitive "no records" answer is not
 * retried. Resolves null when no address was found in time. An abort of
 * `signal` (client disconnect or the request budget) rejects at once with its
 * reason and cancels the queries.
 */
async function resolveWithRetry(
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal: AbortSignal | undefined
): Promise<string[] | null> {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(DNS_LOOKUP_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let attempt = 1; ; attempt += 1) {
    let retryable: boolean;
    try {
      const addresses = await untilAborted(
        Promise.resolve().then(() => resolveHostAddresses(hostname, combined)),
        combined
      );
      if (addresses.length > 0) return addresses;
      retryable = false;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) return null;
      retryable = !DNS_NO_RECORDS_CODES.has(errorCode(error) ?? '');
    }
    if (!retryable || attempt >= DNS_LOOKUP_ATTEMPTS) return null;
    try {
      await untilAborted(new Promise(resolve => setTimeout(resolve, DNS_RETRY_DELAY_MS)), combined);
    } catch {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
  }
}

/** What one resolution of an upstream host produced for the public check. */
type UpstreamHostCheck =
  | { checked: string[]; expiresAt: number }
  | { violation: 'dns_lookup_failed' | 'non_public_address' };

/**
 * Resolves `hostname`, requires every answer to be public, and stores the
 * checked list on success. It never answers from the checked-address cache,
 * because a caller states by running it that the cached list may no longer be
 * trusted. The violation is report-visible only: a non-public answer and a
 * failed lookup leave no checked entry and are answered with different
 * messages. Rejects with the abort reason when `signal` aborts during the
 * lookup.
 */
async function resolveAndCheckUpstreamHost(
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses,
  signal: AbortSignal | undefined
): Promise<UpstreamHostCheck> {
  const addresses = await resolveWithRetry(hostname, resolveHostAddresses, signal);
  if (!addresses) return { violation: 'dns_lookup_failed' };
  if (addresses.some(address => !isPublicIp(address))) {
    return { violation: 'non_public_address' };
  }
  const expiresAt = Date.now() + UPSTREAM_ADDRESS_CACHE_TTL_MS;
  cacheUpstreamAddresses(hostname, addresses, expiresAt);
  return { checked: addresses, expiresAt };
}

/** Test hook. */
export function clearUpstreamUrlPolicyCache(): void {
  checkedUpstreamAddresses.clear();
}

/**
 * Decides whether an upstream URL may be requested. The URL must use HTTPS, and
 * its host and every address it resolves to must be publicly routable.
 *
 * An allowed decision carries the checked address list for that host and when
 * that check expires, and the caller connects to those addresses instead of
 * resolving the name again. The check stores that list for the host's cache
 * TTL, so a caller that no longer trusts its own copy asks
 * `refreshUpstreamHostAddresses` for a fresh one.
 *
 * Rejects with the abort reason when `signal` aborts during the DNS lookup.
 */
export async function findUpstreamUrlViolation(
  value: string,
  {
    resolveHostAddresses = resolveWithSystemResolver,
    signal,
  }: { resolveHostAddresses?: ResolveHostAddresses; signal?: AbortSignal } = {}
): Promise<UpstreamUrlDecision> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, violation: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { allowed: false, violation: 'non_https' };

  const hostname = normalizeUpstreamHostname(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { allowed: false, violation: 'non_public_host' };
  }

  // WHATWG URL parsing already canonicalizes obfuscated literals such as
  // `2130706433` or `0x7f.1` to `127.0.0.1`, so they cannot slip past here.
  if (isIpAddress(hostname)) {
    if (!isPublicIp(hostname)) return { allowed: false, violation: 'non_public_host' };
    // `URL.hostname` keeps the brackets of an IPv6 literal; a dialable address
    // does not have them.
    const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    return {
      allowed: true,
      hostname: literal,
      addresses: [literal],
      expiresAt: Date.now() + UPSTREAM_ADDRESS_CACHE_TTL_MS,
    };
  }

  const cached = cachedUpstreamAddresses(hostname, Date.now());
  if (cached) return { allowed: true, hostname, ...cached };

  // A public-looking name can still point at a private address, for example
  // `metadata.attacker.example` with an A record of 169.254.169.254.
  const check = await resolveAndCheckUpstreamHost(hostname, resolveHostAddresses, signal);
  if ('violation' in check) return { allowed: false, violation: check.violation };
  return { allowed: true, hostname, addresses: check.checked, expiresAt: check.expiresAt };
}

/**
 * The checked address list for `hostname` after a fresh check. A caller states
 * by running this that the stored list for the host may no longer be trusted,
 * for example a connection pool that found its pin expired. It never answers
 * from the checked-address cache, and it stores a list it found public, so a
 * later expiry resolves the same list without another lookup.
 *
 * Resolves null when the check fails or answers an address that is not public,
 * so the caller refuses the connection. It rejects with the abort reason when
 * `signal` aborts during the lookup.
 */
export async function refreshUpstreamHostAddresses(
  hostname: string,
  signal: AbortSignal | undefined
): Promise<string[] | null> {
  const check = await resolveAndCheckUpstreamHost(
    normalizeUpstreamHostname(hostname),
    resolveWithSystemResolver,
    signal
  );
  return 'checked' in check ? check.checked : null;
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
 * An allowed URL and the checked addresses its host resolves to. The addresses
 * are the only ones the caller may dial.
 */
export type AllowedUpstreamUrl = {
  url: string;
  hostname: string;
  addresses: string[];
  /** When the check behind `addresses` expires. */
  expiresAt: number;
};

export type UpstreamUrlPolicyResult =
  | { rejected: NextResponse }
  | {
      rejected: null;
      /** The checked entry for the URL the caller opens the connection to. */
      dialed: AllowedUpstreamUrl;
    };

/**
 * Returns the error response for the first URL that violates the policy, or the
 * checked entry of the hop the caller dials. The secure-proxy relay dials the
 * other URL itself without a check of its own; it is an internal service, so
 * the check here is the only one that URL gets.
 * Rejects with the abort reason when `signal` aborts, exactly like the upstream
 * fetch would, so the caller's fetch-failure handling applies.
 */
export async function rejectDisallowedUpstreamUrls({
  urls,
  providerId,
  vercelRequestId,
  signal,
}: {
  /** The hop the caller dials first, then any URL a relay dials itself. */
  urls: [string, ...string[]];
  providerId: string;
  vercelRequestId: string | null | undefined;
  signal: AbortSignal;
}): Promise<UpstreamUrlPolicyResult> {
  const decisions = await Promise.all(urls.map(url => findUpstreamUrlViolation(url, { signal })));
  for (const [index, decision] of decisions.entries()) {
    if (!decision.allowed) {
      return {
        rejected: rejectionResponse({
          rejection: decision.violation,
          host: hostOf(urls[index]),
          providerId,
          vercelRequestId,
        }),
      };
    }
  }
  // The loop above returned when a decision was not allowed, and `urls` always
  // holds the dialled hop, so the first decision is an allowed one.
  const dialledDecision = decisions[0];
  if (!dialledDecision.allowed) throw new Error('unreachable: every decision above was allowed');
  return {
    rejected: null,
    dialed: {
      url: urls[0],
      hostname: dialledDecision.hostname,
      addresses: dialledDecision.addresses,
      expiresAt: dialledDecision.expiresAt,
    },
  };
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
