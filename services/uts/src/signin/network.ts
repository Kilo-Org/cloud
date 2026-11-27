import { z } from 'zod';
import { ClientAddressSchema, ipv6Hextets } from '../network-address';
import type { NetworkContext } from './store';

/**
 * Where a request came from, as Cloudflare saw it (design 8.2 network fields): the connecting
 * address from `CF-Connecting-IP` only (design 5.12), and the network, country and city from
 * `request.cf`. A value outside its column's shape is left out rather than stored.
 */

const CfSchema = z.looseObject({
  asn: z.number().int().positive().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
});

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
    clientIp: ClientAddressSchema.safeParse(request.headers.get('CF-Connecting-IP')).data ?? null,
    asn: cf?.asn ?? null,
    country: country !== undefined && /^[A-Z]{2}$/.test(country) ? country : null,
    city: city !== undefined && city.length > 0 && city.length <= 128 ? city : null,
  };
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
  return `${ipv6Hextets(clientIp)
    .slice(0, 3)
    .map(group => group.toString(16))
    .join(':')}::/48`;
}
