import { UTS_REFRESH_TOKEN_PREFIX } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

/**
 * Opaque credential values. Each carries 32 random bytes and is stored only as its SHA-256 hash
 * (design 5.2). A first-party refresh grant also names its grant id, so the token endpoint knows
 * the grant, and the signer object the grant id picks, before it reads the grant (design 5.3):
 * `kilo_rt_<grant id, 22 base64url characters><32 random bytes, 43 base64url characters>`. The
 * grant id is not secret (it is the `sid` of every access token); the random part is the secret.
 */

/** Separates the grant id derivation from the stored code hash, a SHA-256 of the code alone. */
const GRANT_ID_LABEL = 'kilo-uts-grant-id:';

const RANDOM_BYTES = 32;
/** 32 bytes in base64url without padding. */
const RANDOM_PART = /^[A-Za-z0-9_-]{43}$/;
const FIRST_PARTY_REFRESH_TOKEN = new RegExp(
  `^${UTS_REFRESH_TOKEN_PREFIX}([A-Za-z0-9_-]{22})[A-Za-z0-9_-]{43}$`
);

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** 32 random bytes as base64url: an authorization code or a third-party refresh token. */
export function randomCredential(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
}

/** True when `value` has the shape of `randomCredential()`. */
export function isRandomCredential(value: string): boolean {
  return RANDOM_PART.test(value);
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

const UuidSchema = z.uuid();

/** The uuid text of 16 bytes. */
function uuidOfBytes(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The uuid that 22 base64url characters encode, or null when they encode no canonical uuid. */
function uuidOfBase64url(value: string): string | null {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== 16 || base64url(bytes) !== value) return null;
  return uuidOfBytes(bytes);
}

/**
 * The grant id a code exchange creates: a version 8 uuid (RFC 9562) from the first 16 bytes of
 * SHA-256 over a fixed label and the code. Every attempt with one code names the same grant, so
 * the proof `jti`s of those attempts are recorded under one grant. The id is public (the `sid` of
 * every token); a hash under another label than the stored code hash, it reveals nothing of the
 * code.
 */
export async function grantIdOfCode(code: string): Promise<string> {
  const bytes = (await sha256(`${GRANT_ID_LABEL}${code}`)).slice(0, 16);
  // RFC 9562: version 8 in the high 4 bits of byte 6, variant 0b10 in the high 2 bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidOfBytes(bytes);
}

export function createFirstPartyRefreshToken(grantId: string): string {
  const grantIdBytes = Buffer.from(UuidSchema.parse(grantId).replaceAll('-', ''), 'hex');
  return `${UTS_REFRESH_TOKEN_PREFIX}${base64url(grantIdBytes)}${randomCredential()}`;
}

/** The grant id a first-party refresh token names, or null when the value has another shape. */
export function grantIdOfFirstPartyRefreshToken(token: string): string | null {
  const match = FIRST_PARTY_REFRESH_TOKEN.exec(token);
  return match === null ? null : uuidOfBase64url(match[1]);
}
