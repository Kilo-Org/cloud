/**
 * The one hostname normalization the upstream URL policy and the pinned
 * upstream connection share. DNS names are case-insensitive and a trailing dot
 * names the same host.
 *
 * It lives here, not in either of them, so the policy does not import the
 * connection module that owns undici.
 */
export function normalizeUpstreamHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}
