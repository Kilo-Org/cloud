/**
 * Read-cache scope derivation, kept free of the native SQLCipher store so a
 * consumer that only needs the scope or its own persisted key never pulls
 * encrypted-kv (and expo-crypto under it) into its import graph.
 */

/** Bump on any breaking change to a persisted query shape. */
export const SCHEMA_VERSION = 1;

export const READ_CACHE_SCOPE_PREFIX = 'cache:';

/** One scope holds one user's read-cache blob for the current schema. */
export function readCacheScope(userId: string): string {
  return `${READ_CACHE_SCOPE_PREFIX}${userId}:${SCHEMA_VERSION}`;
}
