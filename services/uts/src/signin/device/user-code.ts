import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Env } from '../../env';

/**
 * RFC 8628 user codes (section 6.1): 8 characters from 20 consonants, shown as `XXXX-XXXX`, so a
 * code is easy to read and type and spells no word. 20^8 is about 2^34.6 codes; the identity store
 * keeps only an HMAC-SHA-256 of the normalized code under a key only UTS holds (design 5.2), and
 * a session may enter at most 10 wrong codes per hour (`uts.read_device_code`).
 */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const LENGTH = 8;

const KeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A random normalized user code. Rejection sampling keeps every character equally likely. */
export function newUserCode(): string {
  const characters: string[] = [];
  // 240 is the largest multiple of 20 below 256.
  while (characters.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte < 240 && characters.length < LENGTH) characters.push(ALPHABET[byte % 20]);
    }
  }
  return characters.join('');
}

/**
 * The code a user typed, normalized (RFC 8628 section 6.1): upper case, with separators and
 * spaces dropped. Null when what is left is not 8 characters of the alphabet.
 */
export function normalizeUserCode(input: string): string | null {
  if (input.length > 32) return null;
  const normalized = input.toUpperCase().replace(/[\s-]/g, '');
  if (normalized.length !== LENGTH) return null;
  return [...normalized].every(character => ALPHABET.includes(character)) ? normalized : null;
}

/** `XXXX-XXXX`, as the device shows it. */
export function formatUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export type UserCodeKey = CryptoKey;

/**
 * The environment's user-code secret, or null where it is unset: the device grant is then not
 * served. A malformed secret is refused, not used.
 */
export function userCodeSecret(env: Pick<Env, 'DEVICE_USER_CODE_KEY'>): string | null {
  return env.DEVICE_USER_CODE_KEY === undefined ? null : KeySchema.parse(env.DEVICE_USER_CODE_KEY);
}

export async function importUserCodeKey(secret: string): Promise<UserCodeKey> {
  return await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret, 'base64url'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** HMAC-SHA-256 of the normalized code, the value `uts.device_codes.user_code_hash` holds. */
export async function userCodeHash(key: UserCodeKey, normalized: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(normalized))
  );
}
