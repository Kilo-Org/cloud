import { encodeBase62 } from './base62';

export const MESSAGE_ID_PREFIX = 'msg_';
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
