import * as SecureStore from 'expo-secure-store';
import { persistQueryClientSubscribe } from '@tanstack/react-query-persist-client';
import { useEffect } from 'react';

import { writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  clearScope,
  clearScopePrefix,
  getItem,
  removeItem,
  setItem,
} from '@/lib/persist/encrypted-kv';
import {
  createReadCachePersister,
  getBoundReadCacheKv,
  mismatchedRestoredScope,
  type ReadCacheKv,
  SCHEMA_VERSION,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

/** Production SQLCipher KV binding shared by the mount and the root layout. */
export const productionReadCacheKv: ReadCacheKv = {
  getItem,
  setItem,
  removeItem,
  clearScope,
  clearScopePrefix,
};

/**
 * Owner of the encrypted read cache for the authenticated identity. Renders
 * null. On identity resolution it takes over from the cold-start restore,
 * writes the identity hint, and subscribes one scoped persister for
 * `cache:<userId>:<SCHEMA_VERSION>`. Cleanup unsubscribes on epoch change,
 * user change, or unmount.
 */
export function CachePersistenceMount() {
  const { userId, isLoading, isError } = useCurrentUserId();
  const { authEpoch } = useAuth();

  useEffect(() => {
    if (!userId || isLoading || isError) {
      return undefined;
    }

    // The epoch that owns this identity resolution. Every later sign-in or
    // sign-out bumps it, fencing the persister against stale writes. The
    // reactive `authEpoch` re-runs this effect on the bump, so the persister
    // is recreated even when the user id stays equal.
    const epoch = authEpoch;
    const kv = getBoundReadCacheKv();
    if (!kv) {
      return undefined;
    }

    // Authoritative identity takes over from the cold-start hint: a still-
    // pending restore is abandoned, and a completed restore reports the scope
    // it hydrated. A scope from another account is cleared together with the
    // query client, so restored data can never render under the wrong user.
    const restoredScope = takeOverColdStartRestore();
    const mismatchedScope = mismatchedRestoredScope(restoredScope, userId);
    if (mismatchedScope !== null) {
      queryClient.clear();
      void (async () => {
        try {
          await kv.clearScope(mismatchedScope);
        } catch {
          // Best effort: a failed scope clear only costs a future warm start.
        }
      })();
    }

    // Record the identity hint for the next cold start. `writeAccountMetadata`
    // fences the write on the auth epoch; sign-out deletes it.
    void writeAccountMetadata(ACTIVE_USER_ID_KEY, async () => {
      await SecureStore.setItemAsync(ACTIVE_USER_ID_KEY, userId);
    });

    const persister = createReadCachePersister({ kv, queryClient, userId, epoch });
    // Subscribe-only persistence: the root layout already performed the single
    // cold-start restore via `restorePersistedCacheOnColdStart`, so the mount
    // must not restore again (a second restore would re-hydrate and rescope).
    const unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister,
      buster: String(SCHEMA_VERSION),
      dehydrateOptions: {
        shouldDehydrateQuery: shouldPersistReadCacheQuery,
        // No mutation ever enters the read cache: the library default would
        // dehydrate paused mutations, and a restored read cache must never
        // replay one (never-replay).
        shouldDehydrateMutation: () => false,
      },
    });

    return unsubscribe;
  }, [userId, isLoading, isError, authEpoch]);

  return null;
}
