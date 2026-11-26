import { z } from 'zod';
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
    clientIp: IpSchema.safeParse(request.headers.get('CF-Connecting-IP')).data ?? null,
    asn: cf?.asn ?? null,
    country: country !== undefined && /^[A-Z]{2}$/.test(country) ? country : null,
    city: city !== undefined && city.length > 0 && city.length <= 128 ? city : null,
  };
}
