import { base64url } from 'jose';

/**
 * Personal access token format (design 5.3), owned here so UTS mints exactly what verifiers parse:
 *
 *   kilo_pat_ <body: 43 chars> <checksum: 6 chars>
 *
 * - body: 32 random bytes, base64url without padding (canonical: it decodes to 32 bytes and
 *   re-encodes to itself);
 * - checksum: CRC-32 (IEEE) of the ASCII text `kilo_pat_<body>`, as 4 big-endian bytes in base64url
 *   without padding.
 *
 * 58 characters in all. The checksum lets a verifier refuse a mistyped or made-up value offline,
 * before any cache or lookup, and lets secret scanners match the format with few false positives.
 */
export const PAT_PREFIX = 'kilo_pat_';
export const PAT_RANDOM_BYTES = 32;
const BODY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
export const PAT_LENGTH = PAT_PREFIX.length + BODY_LENGTH + CHECKSUM_LENGTH;
const PAT_PATTERN = /^kilo_pat_[A-Za-z0-9_-]{49}$/;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i++) {
    crc = (CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checksum(prefixAndBody: string): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, crc32(prefixAndBody));
  return base64url.encode(bytes);
}

/** A new PAT from 32 bytes of `crypto.getRandomValues`. UTS shows it once and stores `hashPat` of it. */
export function createPatString(): string {
  const body = base64url.encode(crypto.getRandomValues(new Uint8Array(PAT_RANDOM_BYTES)));
  return `${PAT_PREFIX}${body}${checksum(`${PAT_PREFIX}${body}`)}`;
}

/** Whether `value` looks like a PAT at all (prefix only), to route it to PAT verification. */
export function hasPatPrefix(value: string): boolean {
  return value.startsWith(PAT_PREFIX);
}

/** The offline check: prefix, length, alphabet, canonical body, checksum. No I/O. */
export function parsePat(value: string): { ok: true; pat: string } | { ok: false } {
  if (value.length !== PAT_LENGTH || !PAT_PATTERN.test(value)) return { ok: false };
  const body = value.slice(PAT_PREFIX.length, PAT_PREFIX.length + BODY_LENGTH);
  const given = value.slice(PAT_PREFIX.length + BODY_LENGTH);
  const decoded = base64url.decode(body);
  if (decoded.length !== PAT_RANDOM_BYTES || base64url.encode(decoded) !== body)
    return { ok: false };
  if (checksum(`${PAT_PREFIX}${body}`) !== given) return { ok: false };
  return { ok: true, pat: value };
}

/**
 * SHA-256 of the whole PAT, lowercase hex: the key of every cache layer and of the UTS lookup, and
 * what UTS stores (design 5.3).
 */
export async function hashPat(pat: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pat))
  );
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The PAT's token reference for logs and audit rows (design 8.2): the first 8 characters of the
 * base64url SHA-256 of the whole PAT. Same digest as `hashPat`, another encoding and length; it
 * names a PAT in a log line and never serves as a lookup key.
 */
export async function patReference(pat: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pat))
  );
  return base64url.encode(digest).slice(0, 8);
}
