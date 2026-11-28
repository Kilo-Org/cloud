import { v7 } from 'uuid';

/**
 * Mints the id of a usage row (`microdollar_usage`, `exa_usage_log`, `enkrypt_usage`). UUIDv7 ids
 * are time-ordered, so recent rows share index pages in those tables and in the ones keyed by the
 * same id. The embedded timestamp is when the id was minted, usually request start, not the row's
 * `created_at`.
 */
export function createUsageId(): string {
  return v7();
}

const MAX_UUID_V7_MILLISECONDS = 2 ** 48 - 1;
const UUID_V7_HASH_HEX_LENGTH = 19;

/**
 * Builds a UUIDv7 (RFC 9562) from a caller-supplied time and hash instead of the clock and a
 * random source, so the same inputs always give the same id. Use it where a retried or redelivered
 * write must collide on the primary key of a usage table.
 *
 * `milliseconds` fills the 48-bit timestamp. The 12-bit `rand_a` and 62-bit `rand_b` fields are
 * the first 74 bits of `hashHex`; the version and variant bits are set over it.
 */
export function deterministicUuidV7(milliseconds: number, hashHex: string): string {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_UUID_V7_MILLISECONDS
  ) {
    throw new RangeError('UUIDv7 milliseconds must be an integer within 48 bits');
  }
  if (hashHex.length < UUID_V7_HASH_HEX_LENGTH || !/^[0-9a-f]+$/i.test(hashHex)) {
    throw new RangeError(`UUIDv7 hash must be at least ${UUID_V7_HASH_HEX_LENGTH} hex digits`);
  }
  const hash = hashHex.toLowerCase();
  const time = milliseconds.toString(16).padStart(12, '0');
  const variant = ((parseInt(hash[3] ?? '0', 16) & 3) | 8).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hash.slice(0, 3)}-${variant}${hash.slice(4, 7)}-${hash.slice(7, 19)}`;
}
