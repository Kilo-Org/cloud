export const MESSAGE_ID_PREFIX = 'msg_';
export const MESSAGE_ID_TIME_LENGTH = 12;
export const MESSAGE_ID_RANDOM_LENGTH = 14;

export const MESSAGE_ID_LENGTH =
  MESSAGE_ID_PREFIX.length + MESSAGE_ID_TIME_LENGTH + MESSAGE_ID_RANDOM_LENGTH;

export const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export const MESSAGE_ID_FORMAT_DESCRIPTION =
  'messageId must match msg_ followed by 12 lowercase hex characters and 14 base62 characters';

const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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
  const randomSuffix = Array.from(
    randomBytes,
    byte => BASE62_ALPHABET[byte % BASE62_ALPHABET.length]
  ).join('');
  return `${MESSAGE_ID_PREFIX}${createTimePrefix(now)}${randomSuffix}`;
}
