import * as SecureStore from 'expo-secure-store';
import { persistQueryClientSubscribe } from '@tanstack/react-query-persist-client';
import { useEffect, useRef } from 'react';

import { writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { useAuth } from '@/lib/auth/auth-context';
import { isAuthenticatedOwner } from '@/lib/context-scope';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import {
  clearCacheScopeForSignOut,
  createReadCachePersister,
  restorePersistedCacheForOwner,
  shouldPersistReadCacheQuery,
  takeOverColdStartRestore,
} from '@/lib/persist/read-cache';
import { queryClient } from '@/lib/query-client';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';

/** Restore only after network identity proof, then subscribe within that immutable owner generation. */
export function CachePersistenceMount() {
  const { userId, owner, isLoading, isError } = useCurrentUserId();
  const { authEpoch, isSigningOut } = useAuth();
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || isLoading || isError || isSigningOut || !isAuthenticatedOwner(owner)) {
      return undefined;
    }
    let active = true;
    const isCurrent = () => active && isAuthenticatedOwner(owner);
    if (previousUserId.current !== null && previousUserId.current !== userId) {
      void clearCacheScopeForSignOut(previousUserId.current);
    }
    previousUserId.current = userId;
    // The cold-start entry holds a hint only. A mismatch never clears the newly proved identity.
    takeOverColdStartRestore();
    let unsubscribe: (() => void) | undefined = undefined;
    void (async () => {
      try {
        await writeAccountMetadata(
          ACTIVE_USER_ID_KEY,
          async () => {
            await SecureStore.setItemAsync(ACTIVE_USER_ID_KEY, userId);
          },
          isCurrent
        );
      } catch {
        // A failed hint costs a warm start, never owner proof.
      }
      if (!isCurrent()) {
        return;
      }
      await restorePersistedCacheForOwner(queryClient, owner, isCurrent);
      if (!isCurrent()) {
        return;
      }
      unsubscribe = persistQueryClientSubscribe({
        queryClient,
        persister: createReadCachePersister({ queryClient, userId, epoch: authEpoch }),
        dehydrateOptions: {
          shouldDehydrateQuery: shouldPersistReadCacheQuery,
          shouldDehydrateMutation: () => false,
        },
      });
    })();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [userId, owner, isLoading, isError, authEpoch, isSigningOut]);
  return null;
}
