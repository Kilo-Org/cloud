/**
 * Dependency-free RFC 6238 (TOTP) authenticator core for the kilo-mcp worker.
 *
 * There is no TOTP package in the workspace catalog, and a new runtime
 * dependency needs the owner's dependency policy, so this implements TOTP over
 * WebCrypto (`crypto.subtle`), which exists both in workerd and in the node
 * vitest environment via `globalThis.crypto`.
 *
 * Every function is pure: the caller supplies `nowMs`, nothing reads the wall
 * clock, and nothing is logged — a secret or a code must never reach a log, an
 * analytics event or an error message. The errors thrown from here carry no
 * fragment of their input.
 */

/** The RFC 6238 time step, in seconds (the `period` of an authenticator app). */
export const AUTHENTICATOR_STEP_SECONDS = 30;

/** Digits in a generated code. */
export const AUTHENTICATOR_DIGITS = 6;

/** How many steps either side of the current one a submitted code may match. */
export const AUTHENTICATOR_WINDOW_STEPS = 1;

/** Length of a `verifyTotp` code: exactly `AUTHENTICATOR_DIGITS` ASCII digits. */
const CODE_PATTERN = /^[0-9]{6}$/;

/** RFC 4648 §6 base32 alphabet, uppercase. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 asks for at least 128 bits of shared secret; 160 bits is the app default. */
const SECRET_BYTES = 20;

/** The issuer in the `otpauth://` URI and its query parameter. */
const ISSUER = 'Kilo';

/** Thrown for a secret that is not canonical RFC 4648 base32. Carries no input. */
export class InvalidBase32Error extends Error {
  constructor(reason: string) {
    super(`Invalid base32 secret: ${reason}`);
    this.name = 'InvalidBase32Error';
  }
}

/**
 * RFC 4648 base32, unpadded. `generateAuthenticatorSecret` emits exactly this
 * form; `decodeBase32` accepts it plus the padded form an external app may use.
 */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode an RFC 4648 base32 secret. Uppercase, with optional trailing `=`
 * padding; a lowercase or otherwise non-base32 character is malformed and
 * throws. The decode is all-or-nothing: trailing garbage is never skipped and
 * the trailing (sub-byte) bits must be zero, so a tampered secret throws
 * instead of decoding to a partial key.
 */
export function decodeBase32(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new InvalidBase32Error('empty');
  }
  const data = secret.replace(/=+$/, '');
  const padding = secret.length - data.length;
  if (padding >= 8 || (padding > 0 && (data.length + padding) % 8 !== 0)) {
    throw new InvalidBase32Error('bad padding');
  }
  // Base32 cannot carry 1, 3 or 6 characters of data (they leave a partial byte).
  const remainder = data.length % 8;
  if (remainder === 1 || remainder === 3 || remainder === 6) {
    throw new InvalidBase32Error('truncated');
  }
  const out = new Uint8Array(Math.floor((data.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of data) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new InvalidBase32Error('not base32');
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new InvalidBase32Error('trailing bits');
  }
  return out;
}

/**
 * A fresh 160-bit shared secret: 20 random bytes as unpadded uppercase base32
 * (32 characters). Uses the platform CSPRNG; callers store the encoded form.
 */
export function generateAuthenticatorSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

/**
 * The RFC 6238 time step a timestamp falls in: `floor(nowMs / 1000 / 30)`.
 * `nowMs` is always supplied by the caller — this module never reads a clock.
 */
export function currentStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / AUTHENTICATOR_STEP_SECONDS);
}

/** The 8-byte big-endian HOTP counter for a step. */
function counterBytes(step: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(step), false);
  return bytes;
}

/** HMAC-SHA-1 of the counter under the decoded secret. */
async function hmacSha1(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** RFC 4226 dynamic truncation, reduced modulo 10^6 and zero-padded. */
function truncate(digest: Uint8Array): string {
  const offset = digest[19] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** AUTHENTICATOR_DIGITS).padStart(AUTHENTICATOR_DIGITS, '0');
}

/** The code a secret produces at one exact step. */
async function codeForStep(keyBytes: Uint8Array, step: number): Promise<string> {
  return truncate(await hmacSha1(keyBytes, counterBytes(step)));
}

/**
 * The code `secret` produces at `nowMs`, as a zero-padded 6-digit string.
 * `nowMs` is always supplied by the caller.
 */
export async function totpCode(secret: string, nowMs: number): Promise<string> {
  return codeForStep(decodeBase32(secret), currentStep(nowMs));
}

/** The outcome of `verifyTotp`. The matched `step` lets callers enforce single use. */
export type TotpVerification = { ok: true; step: number } | { ok: false };

/** Trim surrounding whitespace and drop a single interior space (`123 456`). */
function normalizeCode(code: string): string {
  return code.trim().replace(' ', '');
}

/** Length-checked, value-constant-time digit comparison. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Verify a submitted code against `secret` at `nowMs`: the current step first,
 * then ±`AUTHENTICATOR_WINDOW_STEPS`. Answers `{ ok: true, step }` with the step
 * that matched (the caller records it to make a code single use) or
 * `{ ok: false }`. A value that is not exactly 6 digits after normalization is
 * refused before any key is imported, so a malformed code never runs an HMAC.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  nowMs: number
): Promise<TotpVerification> {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) {
    return { ok: false };
  }
  const keyBytes = decodeBase32(secret);
  const step = currentStep(nowMs);
  for (let distance = 0; distance <= AUTHENTICATOR_WINDOW_STEPS; distance++) {
    for (const candidateStep of distance === 0 ? [step] : [step - distance, step + distance]) {
      if (candidateStep < 0) {
        continue;
      }
      const candidate = await codeForStep(keyBytes, candidateStep);
      if (constantTimeEquals(candidate, normalized)) {
        return { ok: true, step: candidateStep };
      }
    }
  }
  return { ok: false };
}

/** The label and secret an authenticator app enrols. */
export type AuthenticatorUriInput = {
  /** The unpadded base32 shared secret shown to the admin exactly once. */
  secret: string;
  /** The account identifier embedded in the label (`Kilo:MCP-<account>`). */
  account: string;
};

/**
 * The `otpauth://totp/…` URI an authenticator app scans or imports. Every
 * component is URL-encoded; the output is deterministic for one input.
 */
export function authenticatorUri({ secret, account }: AuthenticatorUriInput): string {
  const label = encodeURIComponent(`${ISSUER}:MCP-${account}`);
  const parameters: Array<[string, string]> = [
    ['secret', secret],
    ['issuer', ISSUER],
    ['algorithm', 'SHA1'],
    ['digits', String(AUTHENTICATOR_DIGITS)],
    ['period', String(AUTHENTICATOR_STEP_SECONDS)],
  ];
  const query = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `otpauth://totp/${label}?${query}`;
}
