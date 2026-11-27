import { z } from 'zod';

/** A client address as the Cloudflare edge gives it in `CF-Connecting-IP`. */
export const ClientAddressSchema = z.union([z.ipv4(), z.ipv6()]);

/** The 8 hextets of a valid IPv6 address; `::` expands, and an IPv4 tail holds the last two. */
export function ipv6Hextets(address: string): number[] {
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

/**
 * The IPv4 address an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) carries, or the address itself
 * for any other valid address.
 */
export function unmappedAddress(address: string): string {
  if (!address.includes(':')) return address;
  const [a, b, c, d, e, mapped, high, low] = ipv6Hextets(address);
  if (a + b + c + d + e !== 0 || mapped !== 0xffff) return address;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Who counts as one client for a per-client limit: the exact IPv4 address, or the IPv6 /64 written
 * as its leading hextets, since one IPv6 subscriber holds a /64 or more and can pick a new address
 * in it for each request. An IPv4-mapped address counts as its IPv4 address. Null for a value that
 * is not an address.
 */
export function clientLimitKey(address: unknown): string | null {
  const parsed = ClientAddressSchema.safeParse(address);
  if (!parsed.success) return null;
  const plain = unmappedAddress(parsed.data);
  if (!plain.includes(':')) return plain;
  return `${ipv6Hextets(plain)
    .slice(0, 4)
    .map(group => group.toString(16))
    .join(':')}::/64`;
}
