import * as z from 'zod';

import { encodeBase62 } from './base62';

export const KILO_SESSION_ID_PREFIX = 'ses_';
export const KILO_SESSION_ID_TIME_LENGTH = 12;
export const KILO_SESSION_ID_RANDOM_LENGTH = 14;

export const KILO_SESSION_ID_LENGTH =
  KILO_SESSION_ID_PREFIX.length + KILO_SESSION_ID_TIME_LENGTH + KILO_SESSION_ID_RANDOM_LENGTH;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `ses_`, a descending 12-hex-character time prefix, then 14 base62 characters.
 * Every other reader of the id shape derives from the declarations above, so a
 * change to the prefix or a length cannot leave one of them on the old shape.
 * The prefix escapes for regex use so a future metacharacter stays a literal.
 */
export const KILO_SESSION_ID_PATTERN = new RegExp(
  `^${escapeRegExp(KILO_SESSION_ID_PREFIX)}[0-9a-f]{${KILO_SESSION_ID_TIME_LENGTH}}[0-9A-Za-z]{${KILO_SESSION_ID_RANDOM_LENGTH}}$`
);

/**
 * A session id as the session store addresses it. Reads must accept every id a
 * `cli_sessions_v2` row can hold, including the ids minted before
 * `KILO_SESSION_ID_PATTERN` became the only issued shape: an older session keeps
 * the id it was created with, and its stored transcript is addressed by that id.
 *
 * Bounded and URL-safe because the id travels as a route segment and becomes a
 * Durable Object name; `/` and U+0000 are never part of one. Authorization does
 * not rest on this shape: a read is allowed only for a row the caller owns, with
 * a current organization membership pass where the row is organization-scoped.
 */
export const storedSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

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

  return descending.toString(16).padStart(KILO_SESSION_ID_TIME_LENGTH, '0');
}

export function generateKiloSessionId(): string {
  const bytes = new Uint8Array(KILO_SESSION_ID_RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  return `${KILO_SESSION_ID_PREFIX}${descendingTimestampHex()}${encodeBase62(bytes)}`;
}
