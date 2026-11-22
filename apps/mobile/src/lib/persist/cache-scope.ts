/**
 * Read-cache scope derivation, kept free of the native SQLCipher store so a
 * consumer that only needs the scope or its own persisted key never pulls
 * encrypted-kv (and expo-crypto under it) into its import graph.
 */

/** Bump on any breaking change to a persisted query shape. */
export const SCHEMA_VERSION = 2;

export const READ_CACHE_SCOPE_PREFIX = 'cache:';

/** One scope holds one user's read-cache blob for the current schema. */
export function readCacheScope(userId: string): string {
  return `${READ_CACHE_SCOPE_PREFIX}${userId}:${SCHEMA_VERSION}`;
}

/**
 * Prefix of the per-account delivery records (the unconfirmed-send memory and
 * the resolved delivery-failure memory). It deliberately shares nothing with
 * `cache:`: those records guard a composer draft and a replayed failure event,
 * both of which outlive the read cache, so sign-out's `cache:<userId>:` sweep
 * and a `SCHEMA_VERSION` bump must not reach them.
 */
const DELIVERY_SCOPE_PREFIX = 'delivery:';

/** One user's delivery-record scope: account-scoped, not schema-versioned. */
export function deliveryScope(userId: string): string {
  return `${DELIVERY_SCOPE_PREFIX}${userId}`;
}
