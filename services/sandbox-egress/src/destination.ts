import { BlockList, isIPv4 } from 'node:net';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');

/** MVP uses IPv4 only. Reject every non-public, mapped or malformed address. */
export function isPublicAddress(address: string): boolean {
  return isIPv4(address) && !blocked.check(address, 'ipv4');
}

export function connectHostname(authority: string | undefined): string | null {
  if (!authority || authority.length > 260) return null;
  const match = /^([A-Za-z0-9.-]+):443$/.exec(authority);
  return match ? (egressDomainSchema.safeParse(match[1]).data ?? null) : null;
}

export class EgressTransportError extends Error {
  constructor(
    readonly code:
      | 'destination_denied'
      | 'dns_unavailable'
      | 'connection_failed'
      | 'response_too_large'
  ) {
    super(code);
    this.name = 'EgressTransportError';
  }
}
