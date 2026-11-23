import { z } from 'zod';

import { encodeBase62 } from './base62';

/**
 * The stem every message id starts with. The canonical prefix adds the `_` that
 * separates it from the time segment, and the stored rule below checks only the
 * stem, so both build on this one declaration instead of re-spelling it.
 */
const MESSAGE_ID_STEM = 'msg';

export const MESSAGE_ID_PREFIX = `${MESSAGE_ID_STEM}_`;
export const MESSAGE_ID_TIME_LENGTH = 12;
export const MESSAGE_ID_RANDOM_LENGTH = 14;

export const MESSAGE_ID_LENGTH =
  MESSAGE_ID_PREFIX.length + MESSAGE_ID_TIME_LENGTH + MESSAGE_ID_RANDOM_LENGTH;

export const MESSAGE_ID_PATTERN = new RegExp(
  `^${MESSAGE_ID_PREFIX}[0-9a-f]{${MESSAGE_ID_TIME_LENGTH}}[0-9A-Za-z]{${MESSAGE_ID_RANDOM_LENGTH}}$`
);

export const MESSAGE_ID_FORMAT_DESCRIPTION =
  `messageId must match ${MESSAGE_ID_PREFIX} followed by ${MESSAGE_ID_TIME_LENGTH} lowercase hex ` +
  `characters and ${MESSAGE_ID_RANDOM_LENGTH} base62 characters`;

export function isCanonicalMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

/**
 * A message id as the session store addresses it. The store keeps the id the
 * sender supplied, so a read must accept every id a stored message row can
 * hold: the canonical `MESSAGE_ID_PATTERN` shape, and the ids that carry only
 * the shared stem, such as a synthetic identity derived from a native event id
 * (the `evt_`-derived `msg_…` the SDK mints for reducer-only messages). Rejecting
 * one such id fails the whole stored page, so the boundary checks the stem and
 * the two characters below, not the canonical time and random segments.
 *
 * `/` and U+0000 are refused because the id becomes a storage key segment
 * (`message/<id>`, `part/<messageId>/<id>`) and part of part identities.
 */
export const storedMessageIdSchema = z
  .string()
  .startsWith(MESSAGE_ID_STEM)
  .refine(id => !id.includes('/') && !id.includes('\u0000'), {
    message: 'message IDs must not contain / or U+0000',
  });

// Shifting the ms timestamp left by 12 bits hex-encodes it as a fixed-width
// prefix that preserves chronological sort order.
function createTimePrefix(now: number): string {
  const timeBytes = new Uint8Array(MESSAGE_ID_TIME_LENGTH / 2);
  const timestamp = BigInt(now) * BigInt(0x1000);
  for (let index = 0; index < timeBytes.length; index++) {
    timeBytes[index] = Number((timestamp >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  return Array.from(timeBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function buildMessageId(now: number, randomBytes: Uint8Array): string {
  // One byte becomes one suffix character, so any other length would produce an
  // id that MESSAGE_ID_PATTERN rejects.
  if (randomBytes.length !== MESSAGE_ID_RANDOM_LENGTH) {
    throw new Error(
      `buildMessageId needs ${MESSAGE_ID_RANDOM_LENGTH} random bytes, got ${randomBytes.length}`
    );
  }
  const randomSuffix = encodeBase62(randomBytes);
  return `${MESSAGE_ID_PREFIX}${createTimePrefix(now)}${randomSuffix}`;
}
