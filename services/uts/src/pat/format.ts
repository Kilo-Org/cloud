import { Buffer } from 'node:buffer';

/**
 * The format of PATs and org bot keys (design 5.3):
 *
 *   <prefix> <body: 43 characters> <checksum: 6 characters>
 *
 * - prefix: `kilo_pat_` for a PAT, `kilo_bot_` for an org bot key; the table fixes it;
 * - body: 32 random bytes, base64url without padding (canonical: it decodes to 32 bytes and
 *   re-encodes to itself);
 * - checksum: CRC-32 (IEEE) of the ASCII text `<prefix><body>`, as 4 big-endian bytes in base64url
 *   without padding.
 *
 * The PAT format is the one `@kilocode/verify` parses (`createPatString`, `parsePat`, `hashPat`,
 * `patReference`); `test/unit/pat-format.test.ts` pins it with fixed vectors. The checksum lets a
 * verifier refuse a mistyped or made-up value offline, and lets secret scanners match the format
 * with few false positives. UTS stores the SHA-256 of the whole value and its last four characters.
 */

export const PAT_PREFIX = 'kilo_pat_';
export const BOT_KEY_PREFIX = 'kilo_bot_';

export type SecretKind = 'pat' | 'bot_key';

const PREFIXES: Readonly<Record<SecretKind, string>> = { pat: PAT_PREFIX, bot_key: BOT_KEY_PREFIX };
const RANDOM_BYTES = 32;
const BODY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
/** Both prefixes are 9 characters, so both formats are 58 characters long. */
const SECRET_LENGTH = PAT_PREFIX.length + BODY_LENGTH + CHECKSUM_LENGTH;
const PATTERNS: Readonly<Record<SecretKind, RegExp>> = {
  pat: /^kilo_pat_[A-Za-z0-9_-]{49}$/,
  bot_key: /^kilo_bot_[A-Za-z0-9_-]{49}$/,
};

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
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(crc32(prefixAndBody));
  return bytes.toString('base64url');
}

/** The secret of `kind` whose body encodes `randomBytes` (32 bytes). */
export function secretOfBytes(kind: SecretKind, randomBytes: Uint8Array): string {
  if (randomBytes.byteLength !== RANDOM_BYTES) throw new Error('expected 32 random bytes');
  const head = `${PREFIXES[kind]}${Buffer.from(randomBytes).toString('base64url')}`;
  return `${head}${checksum(head)}`;
}

/** A new secret from 32 bytes of `crypto.getRandomValues`. UTS shows it once. */
export function createSecret(kind: SecretKind): string {
  return secretOfBytes(kind, crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
}

/** The offline check: prefix, length, alphabet, canonical body, checksum. No I/O. */
export function isWellFormedSecret(kind: SecretKind, value: string): boolean {
  if (value.length !== SECRET_LENGTH || !PATTERNS[kind].test(value)) return false;
  const prefix = PREFIXES[kind];
  const body = value.slice(prefix.length, prefix.length + BODY_LENGTH);
  const decoded = Buffer.from(body, 'base64url');
  if (decoded.byteLength !== RANDOM_BYTES || decoded.toString('base64url') !== body) return false;
  return checksum(`${prefix}${body}`) === value.slice(prefix.length + BODY_LENGTH);
}

/** The SHA-256 of the whole value: what the identity store keeps and looks up. */
export async function secretHash(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** The lookup key verifiers send: the SHA-256 of the whole value as lowercase hex. */
export function hexOfHash(hash: Uint8Array): string {
  return Buffer.from(hash).toString('hex');
}

/** The raw hash a lowercase-hex lookup key names. */
export function hashOfHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** The last four characters, which the account views show. */
export function lastFour(value: string): string {
  return value.slice(-4);
}
