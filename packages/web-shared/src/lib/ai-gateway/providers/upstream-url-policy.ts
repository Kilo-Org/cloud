import { lookup } from 'node:dns/promises';
import { isIpAddress, isPublicIp } from '@kilocode/mcp-gateway';

export type UpstreamUrlViolation =
  | 'invalid_url'
  | 'non_https'
  | 'non_public_host'
  | 'dns_lookup_failed'
  | 'non_public_address';

export type ResolveHostAddresses = (hostname: string) => Promise<string[]>;

const PUBLIC_HOSTNAME_CACHE_TTL_MS = 60 * 1000;
const PUBLIC_HOSTNAME_CACHE_MAX_ENTRIES = 1000;
const DNS_LOOKUP_ATTEMPTS = 2;
const DNS_RETRY_DELAY_MS = 100;
const publicHostnameExpiresAt = new Map<string, number>();

/**
 * Only the production deployment enforces the policy; local development, for
 * example, reaches the fake LLM over plain HTTP on localhost. `NODE_ENV` is
 * `production` on staging and previews too, so it cannot be used here.
 */
export function isUpstreamUrlPolicyEnforced(): boolean {
  return process.env.VERCEL_TARGET_ENV === 'production';
}

async function resolveWithSystemResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
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

/** One retry absorbs a transient resolver failure such as `EAI_AGAIN`. */
async function resolveWithRetry(
  hostname: string,
  resolveHostAddresses: ResolveHostAddresses
): Promise<string[] | null> {
  for (let attempt = 0; attempt < DNS_LOOKUP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, DNS_RETRY_DELAY_MS));
    try {
      const addresses = await resolveHostAddresses(hostname);
      if (addresses.length > 0) return addresses;
    } catch {
      // Retried below; the caller reports dns_lookup_failed once attempts run out.
    }
  }
  return null;
}

export function clearUpstreamUrlPolicyCache(): void {
  publicHostnameExpiresAt.clear();
}

/**
 * Checks that an upstream URL uses HTTPS and that its host, and every address
 * it resolves to, is publicly routable. The resolution happens before the
 * fetch, which resolves again, so this does not stop DNS rebinding; callers
 * must also refuse to follow redirects.
 */
export async function findUpstreamUrlViolation(
  value: string,
  resolveHostAddresses: ResolveHostAddresses = resolveWithSystemResolver
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

  if (isIpAddress(hostname)) {
    return isPublicIp(hostname) ? null : 'non_public_host';
  }

  const now = Date.now();
  if (isCachedPublicHostname(hostname, now)) return null;

  const addresses = await resolveWithRetry(hostname, resolveHostAddresses);
  if (!addresses) return 'dns_lookup_failed';
  if (addresses.some(address => !isPublicIp(address))) return 'non_public_address';

  cachePublicHostname(hostname, now);
  return null;
}
