/**
 * Whether a hostname, in `URL.hostname` form, names the sandbox itself when a
 * server inside it writes that host in a link or a redirect. The web chat link
 * parser and the Worker's `Location` rewrite share this one test.
 *
 * This decides preview routing only. It is a convenience for the address forms
 * a server in the sandbox uses to name itself, not a security boundary: a
 * sandbox server can point a link at any host.
 */
export function isPreviewLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) return isSandboxIpv6(host.slice(1, -1));
  if (isSandboxIpv4(host)) return true;
  const name = host.replace(/\.+$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

/** `127.0.0.0/8`, the whole IPv4 loopback block, and the unspecified `0.0.0.0`. */
function isSandboxIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(part => Number(part));
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 127 || octets.every(octet => octet === 0);
}

const IPV6_HEXTET = /^[0-9a-f]{1,4}$/;

const IPV6_HEXTET_COUNT = 8;
const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff];

/**
 * `::`, `::1`, and the `::ffff:` IPv4-mapped form whose embedded address is
 * itself a sandbox address. The WHATWG URL parser serialises a mapped address
 * as `::ffff:7f00:1`, so the dotted suffix never reaches this function.
 */
function isSandboxIpv6(address: string): boolean {
  const hextets = parseIpv6(address);
  if (hextets === null) return false;
  if (hextets.every(hextet => hextet === 0)) return true;
  const [a = 0, b = 0] = hextets.slice(6);
  const embedded = `${String(a >> 8)}.${String(a & 0xff)}.${String(b >> 8)}.${String(b & 0xff)}`;
  if (hextets[7] === 1 && hextets.slice(0, 7).every(hextet => hextet === 0)) return true;
  if (!IPV4_MAPPED_PREFIX.every((hextet, index) => hextets[index] === hextet)) return false;
  return isSandboxIpv4(embedded);
}

/** The eight hextets of a `::`-compressed IPv6 literal, or null when it is not one. */
function parseIpv6(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const head = parseHalf(halves[0] ?? '');
  const tail = halves.length === 2 ? parseHalf(halves[1] ?? '') : [];
  const missing = IPV6_HEXTET_COUNT - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const parts = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  if (!parts.every(part => IPV6_HEXTET.test(part))) return null;
  return parts.map(part => Number.parseInt(part, 16));
}
