import { UTS_REFRESH_TOKEN_PREFIX } from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

/**
 * Opaque credential values, each stored only as its SHA-256 hash (design 5.2). An authorization
 * code and a third-party refresh token are 32 random bytes. A first-party refresh grant also
 * names its grant id, so the token endpoint knows the grant, and the signer object the grant id
 * picks, before it reads the grant (design 5.3):
 * `kilo_rt_<grant id, 22 base64url characters><secret, 43 base64url characters>`. The grant id
 * is not secret (it is the `sid` of every access token); the secret part is.
 */

/** Separates the grant id derivation from the stored code hash, a SHA-256 of the code alone. */
const GRANT_ID_LABEL = 'kilo-uts-grant-id:';
/** Separates the refresh secret derivation from the grant id and the stored hashes. */
const REFRESH_SECRET_LABEL = 'kilo-uts-first-party-refresh:';
/** Separates the browser-session handle derivation from every other derivation and hash. */
const SESSION_HANDLE_LABEL = 'kilo-uts-browser-session-handle:';

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
 * SHA-256 over a fixed label and the code. Every attempt with one code names the same grant, so a
 * retried first-party exchange gets the grant the first attempt created, and the proof `jti`s of
 * all attempts are recorded under one grant. The id is public (the `sid` of every token); a hash
 * under another label than the stored code hash, it reveals nothing of the code.
 */
export async function grantIdOfCode(code: string): Promise<string> {
  const bytes = (await sha256(`${GRANT_ID_LABEL}${code}`)).slice(0, 16);
  // RFC 9562: version 8 in the high 4 bits of byte 6, variant 0b10 in the high 2 bits of byte 8.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return uuidOfBytes(bytes);
}

/** A first-party refresh token: the grant id and the 43-character secret in the token format. */
export function firstPartyRefreshToken(grantId: string, secret: string): string {
  const grantIdBytes = Buffer.from(UuidSchema.parse(grantId).replaceAll('-', ''), 'hex');
  return `${UTS_REFRESH_TOKEN_PREFIX}${base64url(grantIdBytes)}${secret}`;
}

/**
 * The refresh token a first-party code exchange returns for the grant `grantIdOfCode(code)`. Its
 * secret is SHA-256 over a fixed label, the code and the PKCE verifier, so every attempt with one
 * code and verifier returns the same token: when a client retries while the first answer is still
 * on its way, both answers carry the one token the grant holds, whichever arrives last (design
 * 5.4). The code is 32 random bytes that only the client and the exchange see, the verifier never
 * leaves the client before the exchange, and the identity store keeps only the SHA-256 of each
 * alone, so stored data does not give the secret.
 */
export async function firstPartyRefreshTokenOfExchange(
  grantId: string,
  code: string,
  verifier: string
): Promise<string> {
  const secret = base64url(await sha256(`${REFRESH_SECRET_LABEL}${code}:${verifier}`));
  return firstPartyRefreshToken(grantId, secret);
}

/**
 * The browser-session handle a `kilo-web` code exchange returns: SHA-256 over a fixed label, the
 * code and the PKCE verifier, as base64url (43 characters), derived like the first-party refresh
 * secret. Every attempt with one code and verifier returns the same handle, so a retry after a
 * lost answer gets the handle the session holds (design 5.3), and the identity store, which keeps
 * only the SHA-256 of the code, the verifier's challenge and the handle, does not give it.
 */
export async function browserSessionHandleOfExchange(
  code: string,
  verifier: string
): Promise<string> {
  return base64url(await sha256(`${SESSION_HANDLE_LABEL}${code}:${verifier}`));
}

/** The grant id a first-party refresh token names, or null when the value has another shape. */
export function grantIdOfFirstPartyRefreshToken(token: string): string | null {
  const match = FIRST_PARTY_REFRESH_TOKEN.exec(token);
  return match === null ? null : uuidOfBase64url(match[1]);
}
