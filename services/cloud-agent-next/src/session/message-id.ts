const MESSAGE_ID_PREFIX = 'msg_';
const MESSAGE_ID_TIME_LENGTH = 12;
const MESSAGE_ID_RANDOM_LENGTH = 14;
const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export const MESSAGE_ID_LENGTH =
  MESSAGE_ID_PREFIX.length + MESSAGE_ID_TIME_LENGTH + MESSAGE_ID_RANDOM_LENGTH;

export const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const MESSAGE_ID_FORMAT_DESCRIPTION =
  'messageId must match msg_ followed by 12 lowercase hex characters and 14 base62 characters';

export function isCanonicalMessageId(value: string): boolean {
  return MESSAGE_ID_PATTERN.test(value);
}

/**
 * Produce a 12-character lowercase hex prefix that preserves chronological
 * sort order of the Unix-epoch millisecond timestamp.
 *
 * The ms timestamp is shifted left by 12 bits (`* 0x1000`) and its low 48
 * bits are hex-encoded big-endian. Because the shift is a monotonic
 * multiplication, the resulting hex string preserves sort order. For any
 * realistic wall-clock value (ms timestamps fit in ~41 bits, well below
 * the 48-bit window), no information is lost. The 12-bit shift leaves room
 * for future random-bit packing while keeping the prefix 12 hex chars wide.
 */
function createTimePrefix(now: number): string {
  const timeBytes = new Uint8Array(6);
  const timestamp = BigInt(now) * BigInt(0x1000);
  for (let index = 0; index < timeBytes.length; index++) {
    timeBytes[index] = Number((timestamp >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  return Array.from(timeBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createMessageId(now = Date.now()): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(MESSAGE_ID_RANDOM_LENGTH));
  const randomSuffix = Array.from(
    randomBytes,
    byte => BASE62_ALPHABET[byte % BASE62_ALPHABET.length]
  ).join('');

  return `${MESSAGE_ID_PREFIX}${createTimePrefix(now)}${randomSuffix}`;
}
