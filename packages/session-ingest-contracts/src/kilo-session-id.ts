import * as z from 'zod';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `ses_`, a descending 12-hex-character time prefix, then 14 base62 characters. */
export const KILO_SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * A session id proposed by a client so it can show the session before the server
 * confirms it. Stricter than `sessionIdSchema`, which also accepts older ids.
 */
export const clientKiloSessionIdSchema = z.string().regex(KILO_SESSION_ID_PATTERN);

let counter = 0;

function descendingTimestampHex(): string {
  const tick = BigInt(Date.now()) * BigInt(0x1000) + BigInt(counter);
  counter = (counter + 1) & 0xfff;

  // 6-byte mask (48 bits) — invert so newer timestamps sort first
  const descending = ~tick & BigInt(0xffff_ffff_ffff);

  return descending.toString(16).padStart(12, '0');
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let result = '';
  for (const byte of bytes) {
    result += BASE62[byte % 62];
  }
  return result;
}

export function generateKiloSessionId(): string {
  return `ses_${descendingTimestampHex()}${randomBase62(14)}`;
}
