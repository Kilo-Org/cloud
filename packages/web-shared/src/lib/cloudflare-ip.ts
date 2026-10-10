// Cloudflare IP range detection.
// Ranges from https://api.cloudflare.com/client/v4/ips (change rarely — last update Sep 2023).

// --- IPv4 helpers ---

type ParsedIPv4Range = {
  maskedAddr: number;
  mask: number;
};

function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function parseIPv4CIDR(cidr: string): ParsedIPv4Range | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return null;
  const addr = parseIPv4(cidr.slice(0, slashIdx));
  if (addr === null) return null;
  const prefixLen = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return null;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { maskedAddr: (addr & mask) >>> 0, mask };
}

// --- IPv6 helpers ---

type ParsedIPv6Range = {
  maskedAddr: bigint;
  mask: bigint;
};

function parseIPv6(ip: string): bigint | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const leftParts = halves[0] ? halves[0].split(':') : [];
  const rightParts = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  const totalParts = leftParts.length + rightParts.length;
  if (halves.length === 1 && totalParts !== 8) return null;
  if (halves.length === 2 && totalParts > 7) return null;

  const zeroFill = 8 - totalParts;
  const allParts = [...leftParts, ...Array<string>(zeroFill).fill('0'), ...rightParts];
  if (allParts.length !== 8) return null;

  let result = BigInt(0);
  for (const part of allParts) {
    if (part.length === 0 || part.length > 4) return null;
    const n = parseInt(part, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    result = (result << BigInt(16)) | BigInt(n);
  }
  return result;
}

function parseIPv6CIDR(cidr: string): ParsedIPv6Range | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return null;
  const addr = parseIPv6(cidr.slice(0, slashIdx));
  if (addr === null) return null;
  const prefixLen = Number(cidr.slice(slashIdx + 1));
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 128) return null;
  const fullMask = (BigInt(1) << BigInt(128)) - BigInt(1);
  const mask =
    prefixLen === 0 ? BigInt(0) : (fullMask >> BigInt(128 - prefixLen)) << BigInt(128 - prefixLen);
  return { maskedAddr: addr & mask, mask };
}

// --- Parsed ranges (computed once at module evaluation) ---

// Source: https://api.cloudflare.com/client/v4/ips
const IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
].flatMap(cidr => {
  const parsed = parseIPv4CIDR(cidr);
  return parsed ? [parsed] : [];
});

const IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
].flatMap(cidr => {
  const parsed = parseIPv6CIDR(cidr);
  return parsed ? [parsed] : [];
});

// --- Public API ---

/** Returns true if the given IP address belongs to Cloudflare's network. */
export function isCloudflareIP(ip: string): boolean {
  if (ip.includes(':')) {
    const addr = parseIPv6(ip);
    if (addr === null) return false;
    for (const range of IPV6_RANGES) {
      if ((addr & range.mask) === range.maskedAddr) return true;
    }
    return false;
  }

  const addr = parseIPv4(ip);
  if (addr === null) return false;
  for (const range of IPV4_RANGES) {
    if ((addr & range.mask) >>> 0 === range.maskedAddr) return true;
  }
  return false;
}
