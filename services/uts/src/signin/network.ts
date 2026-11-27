import { z } from 'zod';
import type { NetworkContext } from './store';

/**
 * Where a request came from, as Cloudflare saw it (design 8.2 network fields): the connecting
 * address from `CF-Connecting-IP` only (design 5.12), and the network, country and city from
 * `request.cf`. A value outside its column's shape is left out rather than stored. An
 * IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as the IPv4 address it carries, so it falls
 * in that address's /24, not in one IPv6 /48 that every such address would share.
 */

const CfSchema = z.looseObject({
  asn: z.number().int().positive().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
});
const IpSchema = z.union([z.ipv4(), z.ipv6()]);

/** At most the 512 characters a session row keeps. */
const MAX_USER_AGENT_LENGTH = 512;

export function requestNetwork(request: Request): NetworkContext {
  const cf = CfSchema.safeParse(request.cf).data;
  const country = cf?.country;
  const city = cf?.city;
  const userAgent = request.headers.get('User-Agent');
  return {
    userAgent:
      userAgent === null || userAgent.length === 0
        ? null
        : userAgent.slice(0, MAX_USER_AGENT_LENGTH),
    clientIp: clientAddress(IpSchema.safeParse(request.headers.get('CF-Connecting-IP')).data),
    asn: cf?.asn ?? null,
    country: country !== undefined && /^[A-Z]{2}$/.test(country) ? country : null,
    city: city !== undefined && city.length > 0 && city.length <= 128 ? city : null,
  };
}

/** The 8 hextets of a valid IPv6 address; `::` expands, and an IPv4 tail holds the last two. */
function hextets(address: string): number[] {
  const groups = (part: string) =>
    part === ''
      ? []
      : part.split(':').flatMap(group => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          const [a, b, c, d] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head, tail] = address.split('::');
  const leading = groups(head);
  const trailing = tail === undefined ? [] : groups(tail);
  return [
    ...leading,
    ...Array.from({ length: 8 - leading.length - trailing.length }, () => 0),
    ...trailing,
  ];
}

/** A valid address as stored: an IPv4-mapped IPv6 address becomes its IPv4 address. */
function clientAddress(address: string | undefined): string | null {
  if (address === undefined) return null;
  if (!address.includes(':')) return address;
  const [a, b, c, d, e, mapped, high, low] = hextets(address);
  if (a + b + c + d + e !== 0 || mapped !== 0xffff) return address;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Who counts as one anonymous writer, as `uts.anonymous_writer` defines it (migration 0008), for
 * an address `requestNetwork` accepted: the exact IPv4 address, so one host cannot use up an
 * office /24, or the IPv6 /48 written as its leading hextets, since one IPv6 subscriber holds a
 * /64 or more and an exact address would bound nothing. Null without an address.
 */
export function anonymousWriter(clientIp: string | null): string | null {
  if (clientIp === null) return null;
  if (!clientIp.includes(':')) return clientIp;
  return `${hextets(clientIp)
    .slice(0, 3)
    .map(group => group.toString(16))
    .join(':')}::/48`;
}
