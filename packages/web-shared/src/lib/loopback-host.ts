/**
 * Whether a hostname names the machine the code runs on.
 *
 * These are the spellings a connection URL or an environment variable can hold: `localhost`,
 * the IPv4 address, and the IPv6 address, which `new URL()` keeps in brackets — both forms are
 * listed because a caller may pass either. Shared so that every refusal of a remote target agrees
 * on the same set.
 */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
};

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES[hostname] === true;
}
