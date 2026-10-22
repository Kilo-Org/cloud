const ipv4Pattern =
  /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const zero = BigInt(0);
const allBits = BigInt('0xffff');

function toBigInt(value: string): bigint {
  return BigInt(value);
}

function ipv4ToNumber(address: string): number | null {
  if (!ipv4Pattern.test(address)) return null;
  const parts = address.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Cidr(address: string, base: string, prefix: number): boolean {
  const value = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (value === null || baseValue === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function normalizeIpLiteral(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIpv6(address: string): bigint[] | null {
  const normalized = normalizeIpLiteral(address).toLowerCase();
  if (!normalized.includes(':')) return null;
  if (normalized.includes('.')) return null;
  const parts = normalized.split('::');
  if (parts.length > 2) return null;
  const parseParts = (value: string): Array<bigint | null> => {
    if (!value) return [];
    return value.split(':').map(part => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      return BigInt(`0x${part}`);
    });
  };
  const left = parseParts(parts[0] ?? '');
  const right = parseParts(parts[1] ?? '');
  if (left.includes(null) || right.includes(null)) return null;
  const leftValues = left.filter((part): part is bigint => part !== null);
  const rightValues = right.filter((part): part is bigint => part !== null);
  if (parts.length === 1) {
    if (leftValues.length !== 8) return null;
    return leftValues;
  }
  if (leftValues.length + rightValues.length >= 8) return null;
  return [
    ...leftValues,
    ...Array<bigint>(8 - leftValues.length - rightValues.length).fill(zero),
    ...rightValues,
  ];
}

function inIpv6Prefix(address: string, prefix: bigint[], prefixBits: number): boolean {
  const parsed = parseIpv6(address);
  if (!parsed || prefix.length !== 8) return false;
  let remaining = prefixBits;
  for (let index = 0; index < 8; index += 1) {
    if (remaining <= 0) return true;
    const bits = Math.min(remaining, 16);
    const mask = bits === 16 ? allBits : (allBits << BigInt(16 - bits)) & allBits;
    if ((parsed[index] & mask) !== (prefix[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

export function isIpAddress(value: string): boolean {
  return ipv4Pattern.test(value) || parseIpv6(value) !== null;
}

export function isPublicIp(address: string): boolean {
  if (ipv4Pattern.test(address)) {
    return !(
      inIpv4Cidr(address, '0.0.0.0', 8) ||
      inIpv4Cidr(address, '10.0.0.0', 8) ||
      inIpv4Cidr(address, '100.64.0.0', 10) ||
      inIpv4Cidr(address, '127.0.0.0', 8) ||
      inIpv4Cidr(address, '169.254.0.0', 16) ||
      inIpv4Cidr(address, '172.16.0.0', 12) ||
      inIpv4Cidr(address, '192.0.0.0', 24) ||
      inIpv4Cidr(address, '192.0.2.0', 24) ||
      inIpv4Cidr(address, '192.88.99.0', 24) ||
      inIpv4Cidr(address, '192.168.0.0', 16) ||
      inIpv4Cidr(address, '198.18.0.0', 15) ||
      inIpv4Cidr(address, '198.51.100.0', 24) ||
      inIpv4Cidr(address, '203.0.113.0', 24) ||
      inIpv4Cidr(address, '224.0.0.0', 4) ||
      inIpv4Cidr(address, '240.0.0.0', 4)
    );
  }

  const normalized = normalizeIpLiteral(address).toLowerCase();
  const parsed = parseIpv6(normalized);
  if (!parsed) return false;
  if (inIpv6Prefix(normalized, [zero, zero, zero, zero, zero, zero, zero, zero], 128)) return false;
  if (inIpv6Prefix(normalized, [zero, zero, zero, zero, zero, zero, zero, BigInt(1)], 128))
    return false;
  if (inIpv6Prefix(normalized, [zero, zero, zero, zero, zero, allBits, zero, zero], 96))
    return false;
  if (inIpv6Prefix(normalized, [toBigInt('0xfc00'), zero, zero, zero, zero, zero, zero, zero], 7))
    return false;
  if (inIpv6Prefix(normalized, [toBigInt('0xfe80'), zero, zero, zero, zero, zero, zero, zero], 10))
    return false;
  if (inIpv6Prefix(normalized, [toBigInt('0xff00'), zero, zero, zero, zero, zero, zero, zero], 8))
    return false;
  if (
    inIpv6Prefix(
      normalized,
      [toBigInt('0x2001'), toBigInt('0xdb8'), zero, zero, zero, zero, zero, zero],
      32
    )
  )
    return false;
  if (inIpv6Prefix(normalized, [toBigInt('0x2001'), zero, zero, zero, zero, zero, zero, zero], 32))
    return false;
  if (
    inIpv6Prefix(
      normalized,
      [toBigInt('0x2001'), toBigInt('0x2'), zero, zero, zero, zero, zero, zero],
      48
    )
  )
    return false;
  if (
    inIpv6Prefix(
      normalized,
      [toBigInt('0x2001'), toBigInt('0x10'), zero, zero, zero, zero, zero, zero],
      28
    )
  )
    return false;
  if (
    inIpv6Prefix(
      normalized,
      [toBigInt('0x2001'), toBigInt('0x20'), zero, zero, zero, zero, zero, zero],
      28
    )
  )
    return false;
  if (inIpv6Prefix(normalized, [toBigInt('0x3fff'), zero, zero, zero, zero, zero, zero, zero], 20))
    return false;
  return inIpv6Prefix(
    normalized,
    [toBigInt('0x2000'), zero, zero, zero, zero, zero, zero, zero],
    3
  );
}
