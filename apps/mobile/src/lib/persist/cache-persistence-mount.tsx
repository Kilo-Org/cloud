import * as SecureStore from 'expo-secure-store';
import { persistQueryClientSubscribe } from '@tanstack/react-query-persist-client';
import { useEffect, useRef } from 'react';

import { writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { clearScope } from '@/lib/persist/encrypted-kv';
import {
  clearCacheScopeForSignOut,
  createReadCachePersister,
  readCacheScope,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

/**
 * Owner of the encrypted read cache for the authenticated identity. Renders
 * null. On identity resolution it takes over from the cold-start restore,
 * writes the identity hint, and subscribes one scoped persister for
 * `cache:<userId>:<SCHEMA_VERSION>`. Cleanup unsubscribes on epoch change,
 * user change, or unmount.
 */
export function CachePersistenceMount() {
  const { userId, isLoading, isError } = useCurrentUserId();
  const { authEpoch, isSigningOut } = useAuth();
  // The last authenticated user id this mount subscribed for. A direct
  // account switch (sign-in over an existing session, without a sign-out) does
  // not run the sign-out cleanup, so the mount is the only owner that can drop
  // the previous account's cache scope when the authoritative user id changes.
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    // While sign-out is active the old user id is still cached (the query
    // client is only cleared at the end of sign-out): refuse to subscribe so
    // a resubscription fenced on the new epoch cannot publish the old user's
    // blob before the sign-out cleanup finishes.
    if (!userId || isLoading || isError || isSigningOut) {
      return undefined;
    }

    // Account change: drop the previous account's read-cache scope. The
    // sign-out path already clears the scope, so this only fires on a direct
    // switch where the sign-out cleanup never ran. Best effort: the helper
    // swallows a storage failure, and a redundant clear only costs a future
    // warm start.
    const previousUserId = previousUserIdRef.current;
    if (previousUserId !== null && previousUserId !== userId) {
      void clearCacheScopeForSignOut(previousUserId);
    }
    previousUserIdRef.current = userId;

    // The epoch that owns this identity resolution. Every later sign-in or
    // sign-out bumps it, fencing the persister against stale writes. The
    // reactive `authEpoch` re-runs this effect on the bump, so the persister
    // is recreated even when the user id stays equal. `isSigningOut` re-runs
    // the effect too: sign-out flips it in the same render as the bump, so
    // the teardown below runs and the body returns early instead of
    // resubscribing while the old user id is still cached.
    const epoch = authEpoch;

    // Authoritative identity takes over from the cold-start hint: a still-
    // pending restore is abandoned, and a completed restore reports the scope
    // it hydrated. A scope from another account is cleared together with the
    // query client, so restored data can never render under the wrong user.
    // The hint only survives an interrupted teardown, and authoritative
    // identity wins.
    const restoredScope = takeOverColdStartRestore();
    if (restoredScope !== null && restoredScope !== readCacheScope(userId)) {
      queryClient.clear();
      void (async () => {
        try {
          await clearScope(restoredScope);
        } catch {
          // Best effort: a failed scope clear only costs a future warm start.
        }
      })();
    }

    // Record the identity hint for the next cold start. `writeAccountMetadata`
    // fences the write on the auth epoch; sign-out deletes it. The write is
    // best effort and its rejection is swallowed so a SecureStore failure can
    // never escape as an unhandled rejection (a failed hint only costs a
    // future warm start).
    void (async () => {
      try {
        await writeAccountMetadata(ACTIVE_USER_ID_KEY, async () => {
          await SecureStore.setItemAsync(ACTIVE_USER_ID_KEY, userId);
        });
      } catch {
        // Best effort: a failed identity hint only costs a future warm start.
      }
    })();

    const persister = createReadCachePersister({ queryClient, userId, epoch });
    // Subscribe-only persistence: the root layout already performed the single
    // cold-start restore via `restorePersistedCacheOnColdStart`, so the mount
    // must not restore again (a second restore would re-hydrate and rescope).
    // No `buster`: the scope segment carries the schema version, so a blob from
    // an older schema lives in another scope and is never read.
    const unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister,
      dehydrateOptions: {
        shouldDehydrateQuery: shouldPersistReadCacheQuery,
        // No mutation ever enters the read cache: the library default would
        // dehydrate paused mutations, and a restored read cache must never
        // replay one (never-replay).
        shouldDehydrateMutation: () => false,
      },
    });

    return unsubscribe;
  }, [userId, isLoading, isError, authEpoch, isSigningOut]);

  return null;
}
