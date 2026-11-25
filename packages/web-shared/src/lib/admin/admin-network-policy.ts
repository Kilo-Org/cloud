import { isIP } from 'node:net';
import * as z from 'zod';

/**
 * The admin network allowlist: one environment value, one parser, one set of
 * edge path patterns. The in-app guard (`admin-network.ts`) and the Vercel
 * Firewall rule script both read from here, so the two layers cannot disagree
 * on what the list means or which paths it protects.
 *
 * Kept free of `server-only` and environment reads so the firewall rule
 * script can import it outside Next.js.
 */

export type AdminNetworkFamily = 'ipv4' | 'ipv6';

export type AdminNetworkEntry = {
  family: AdminNetworkFamily;
  address: string;
  /** Null for a single address. */
  prefix: number | null;
};

const IPV4_MAPPED_IPV6 = /^(?:::|(?:0{1,4}:){5})ffff:(.+)$/i;
const IPV4_MAPPED_HEX_TAIL = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * The IPv4 address an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`,
 * `::ffff:c000:201`) carries, or null for any other address.
 */
function ipv4FromMappedIpv6(address: string): string | null {
  const tail = IPV4_MAPPED_IPV6.exec(address)?.[1];
  if (tail === undefined) return null;
  if (isIP(tail) === 4) return tail;
  const hex = IPV4_MAPPED_HEX_TAIL.exec(tail);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] ?? '', 16);
  const low = Number.parseInt(hex[2] ?? '', 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Family and address to check a client address under. An IPv4-mapped IPv6
 * address is checked as the IPv4 address it carries, so an IPv4 entry covers
 * it. Null when the value is not an IP address.
 */
export function normalizeClientAddress(
  value: string
): { family: AdminNetworkFamily; address: string } | null {
  const version = isIP(value);
  if (version === 4) return { family: 'ipv4', address: value };
  if (version !== 6) return null;
  const mapped = ipv4FromMappedIpv6(value);
  return mapped === null ? { family: 'ipv6', address: value } : { family: 'ipv4', address: mapped };
}

const PREFIX_DIGITS = /^\d{1,3}$/;

function parseEntry(entry: string): AdminNetworkEntry | null {
  const slash = entry.indexOf('/');
  const addressText = slash === -1 ? entry : entry.slice(0, slash);
  const prefixText = slash === -1 ? null : entry.slice(slash + 1);
  const address = normalizeClientAddress(addressText);
  if (address === null) return null;
  if (prefixText === null) return { ...address, prefix: null };
  if (!PREFIX_DIGITS.test(prefixText)) return null;

  const prefix = Number(prefixText);
  if (address.family === 'ipv4' && isIP(addressText) === 6) {
    // A mapped IPv6 range covers IPv4 space only from /96 on.
    return prefix >= 96 && prefix <= 128 ? { ...address, prefix: prefix - 96 } : null;
  }
  const maxPrefix = address.family === 'ipv4' ? 32 : 128;
  return prefix <= maxPrefix ? { ...address, prefix } : null;
}

const adminNetworkEntrySchema = z
  .string()
  .trim()
  .transform((entry, ctx) => {
    const parsed = parseEntry(entry);
    if (parsed === null) {
      // The entry itself stays out of the message: the list is internal data
      // and this message reaches deployment logs.
      ctx.addIssue({ code: 'custom', message: 'not an IP address or CIDR range' });
      return z.NEVER;
    }
    return parsed;
  });

/**
 * `ADMIN_ALLOWED_NETWORKS`: comma-separated IPv4/IPv6 addresses and CIDR
 * ranges. One invalid or empty entry rejects the whole value, so a typo can
 * never silently narrow or widen the list.
 */
export const adminAllowedNetworksSchema = z
  .string()
  .transform(value => value.split(','))
  .pipe(z.array(adminNetworkEntrySchema));

export type AdminAllowedNetworksParse =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; entries: AdminNetworkEntry[] };

export function parseAdminAllowedNetworks(value: string | undefined): AdminAllowedNetworksParse {
  if (value === undefined || value.trim() === '') return { kind: 'empty' };
  const result = adminAllowedNetworksSchema.safeParse(value);
  if (result.success) return { kind: 'valid', entries: result.data };
  const message = result.error.issues
    .map(issue => {
      const index = issue.path[0];
      return typeof index === 'number' ? `entry ${index + 1}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return { kind: 'invalid', message };
}

export function formatAdminNetworkEntry(entry: AdminNetworkEntry): string {
  return entry.prefix === null ? entry.address : `${entry.address}/${entry.prefix}`;
}

/**
 * tRPC namespaces in which every procedure requires Kilo admin.
 * `privileged-inventory.test.ts` fails if a procedure matched here is not an
 * admin procedure, or if a namespace stops matching any procedure. A namespace
 * that mixes in organization-owner procedures must never be listed: the edge
 * would refuse org owners who are not on the corporate network.
 */
export const ADMIN_ONLY_TRPC_NAMESPACES = [
  'admin.',
  'organizations.admin.',
  'codeIndexing.admin.',
  'codingPlans.admin',
  'debug.',
] as const;

/**
 * Vercel Firewall operators are case-insensitive, so the in-app matchers use
 * the same semantics.
 */
export function isAdminOnlyTrpcProcedure(procedurePath: string): boolean {
  const lowered = procedurePath.toLowerCase();
  return ADMIN_ONLY_TRPC_NAMESPACES.some(namespace => lowered.startsWith(namespace.toLowerCase()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ADMIN_PAGE_PATH_PATTERN = '^/admin(?:/|$)';

// A tRPC batch joins procedure names with commas in one path segment
// (`/api/trpc/user.getMe,admin.users.list`); a client may percent-encode them.
// The match stops at `?` so a query string can never name a procedure.
const ADMIN_TRPC_PATH_PATTERN = `^/api/trpc/(?:[^/?]*(?:,|%2[cC]))?(?:${ADMIN_ONLY_TRPC_NAMESPACES.map(
  escapeRegExp
).join('|')})`;

/** PCRE patterns for the Vercel Firewall `path` condition (op `re`). */
export const ADMIN_EDGE_PATH_PATTERNS = [ADMIN_PAGE_PATH_PATTERN, ADMIN_TRPC_PATH_PATTERN] as const;

export function isAdminEdgePath(pathname: string): boolean {
  return ADMIN_EDGE_PATH_PATTERNS.some(pattern => new RegExp(pattern, 'i').test(pathname));
}

export const ADMIN_NETWORK_FIREWALL_RULE_NAME = 'Admin network allowlist';

/**
 * The Vercel Firewall custom rule for `vercel firewall rules add --json`:
 * deny a request to an admin path from an address outside the list. Groups
 * are OR'd and the conditions inside a group are AND'd.
 */
export function adminNetworkFirewallRule(entries: readonly AdminNetworkEntry[]) {
  const outsideAllowlist = {
    type: 'ip_address',
    op: 'ninc',
    value: entries.map(formatAdminNetworkEntry),
  } as const;
  return {
    name: ADMIN_NETWORK_FIREWALL_RULE_NAME,
    description: 'Deny admin paths outside ADMIN_ALLOWED_NETWORKS',
    active: true,
    conditionGroup: ADMIN_EDGE_PATH_PATTERNS.map(pattern => ({
      conditions: [{ type: 'path', op: 're', value: pattern } as const, outsideAllowlist],
    })),
    action: { mitigate: { action: 'deny' } },
  } as const;
}
