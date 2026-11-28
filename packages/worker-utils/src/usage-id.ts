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
