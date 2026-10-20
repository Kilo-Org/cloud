/**
 * Rules for the upstream URLs an AI gateway request may contact.
 *
 * An upstream URL uses HTTPS and names a public address, and the addresses a
 * check reports are the ones the connection uses. Custom LLM definitions carry
 * their own URLs, so these rules apply to every URL a request resolves to.
 */
import { lookup } from 'node:dns/promises';
import { isIpAddress, isPublicIp } from './ip-address';

export type UpstreamUrlViolation =
  | 'invalid_url'
  | 'non_https'
  | 'non_public_host'
  | 'dns_lookup_failed'
  | 'non_public_address';

export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

export type UpstreamUrlVerdict =
  | { allowed: true; hostname: string; addresses: string[] }
  | { allowed: false; violation: UpstreamUrlViolation };

const PUBLIC_HOSTNAME_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_HOSTNAME_CACHE_MAX_ENTRIES = 1000;
const DNS_LOOKUP_ATTEMPTS = 2;
const DNS_RETRY_DELAY_MS = 100;
const DNS_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * A hostname's verdict and the addresses that verdict covers. The same window
 * governs `validatedUpstreamAddresses`, so a caller that connects right after a
 * check connects to an address the check saw.
 */
const approvedHostnames = new Map<string, { addresses: string[]; expiresAt: number }>();

/**
 * Active in deployed environments. Local development uses the development
 * target, or the development runtime when no deployment target is supplied.
 */
export function isUpstreamUrlPolicyEnforced(): boolean {
  return (process.env.VERCEL_TARGET_ENV ?? process.env.NODE_ENV) !== 'development';
}

async function resolveWithSystemResolver(hostname: string): Promise<string[]> {
  // The same getaddrinfo resolver fetch uses, so /etc/hosts entries are seen too.
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function approvedAddresses(hostname: string, now: number): string[] | null {
  const approved = approvedHostnames.get(hostname);
  if (approved === undefined) return null;
  if (approved.expiresAt > now) return approved.addresses;
  approvedHostnames.delete(hostname);
  return null;
}

function approveHostname(hostname: string, addresses: string[], now: number): void {
  if (approvedHostnames.size >= PUBLIC_HOSTNAME_CACHE_MAX_ENTRIES) {
    // Map iteration follows insertion order, so this drops the oldest approval.
    // Evicting one entry at a time keeps approvals that in-flight requests are
    // about to connect with.
    const oldest = approvedHostnames.keys().next();
    if (!oldest.done) approvedHostnames.delete(oldest.value);
  }
  approvedHostnames.set(hostname, { addresses, expiresAt: now + PUBLIC_HOSTNAME_CACHE_TTL_MS });
}

/**
 * Settles with `promise`, or rejects with the abort reason as soon as `signal`
 * aborts. `dns.lookup` cannot be cancelled, so a stalled getaddrinfo keeps its
 * thread-pool slot, but the request no longer waits for it.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const settled = Promise.withResolvers<T>();
  const onAbort = () => settled.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(settled.resolve, settled.reject).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
  return settled.promise;
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
  approvedHostnames.clear();
}

/**
 * The addresses a check approved for `hostname`, or null when no check covers
 * it right now. Connections use these instead of resolving the name again, so
 * every socket carries an address a check has seen.
 */
export function validatedUpstreamAddresses(hostname: string): string[] | null {
  return approvedAddresses(hostname.toLowerCase().replace(/\.$/, ''), Date.now());
}

/**
 * Checks that an upstream URL uses HTTPS and that its host, and every address
 * it resolves to, is publicly routable. An allowed verdict reports the
 * addresses it covers; pass them to the connection so the socket is bound to
 * an address this check saw rather than to a second resolution.
 *
 * Rejects with the abort reason when `signal` aborts during the DNS lookup.
 */
export async function checkUpstreamUrl(
  value: string,
  {
    resolveHostAddresses = resolveWithSystemResolver,
    signal,
  }: { resolveHostAddresses?: ResolveHostAddresses; signal?: AbortSignal } = {}
): Promise<UpstreamUrlVerdict> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { allowed: false, violation: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { allowed: false, violation: 'non_https' };

  // A trailing dot names the same host; compare and cache the canonical form.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { allowed: false, violation: 'non_public_host' };
  }

  // WHATWG URL parsing already canonicalizes obfuscated literals such as
  // `2130706433` or `0x7f.1` to `127.0.0.1`, so they cannot slip past here.
  if (isIpAddress(hostname)) {
    if (!isPublicIp(hostname)) return { allowed: false, violation: 'non_public_host' };
    return { allowed: true, hostname, addresses: [hostname] };
  }

  const now = Date.now();
  const approved = approvedAddresses(hostname, now);
  if (approved) return { allowed: true, hostname, addresses: approved };

  // A name is only as public as every address it answers with.
  const addresses = await resolveWithRetry(hostname, resolveHostAddresses, signal);
  if (!addresses) return { allowed: false, violation: 'dns_lookup_failed' };
  if (addresses.some(address => !isPublicIp(address))) {
    return { allowed: false, violation: 'non_public_address' };
  }

  approveHostname(hostname, addresses, now);
  return { allowed: true, hostname, addresses };
}
