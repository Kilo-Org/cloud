import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';

/**
 * Invalidates the given tRPC path-prefix query keys when the route regains
 * foreground freshness:
 *
 * - on the AppState false -> true transition to active while the route is
 *   focused, and
 * - on every route focus regain after the first (the mount focus is already
 *   covered by refetchOnMount).
 *
 * Keys are tRPC path-prefix arrays (e.g. `[['securityAgent']]`), which match
 * every procedure and scope variant under the prefix; only mounted observers
 * refetch.
 */
export function useRouteForegroundRefresh(queryKeys: readonly (readonly unknown[])[]): void {
  const queryClient = useQueryClient();
  const { isActive } = useAppLifecycle();
  const isFocused = useIsFocused();

  // Keep the latest keys in a ref so the focus effect callback stays stable:
  // the owner passes an inline array literal, which is a fresh reference every
  // render, and a changing useFocusEffect callback would re-run on every render.
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;

  const wasActiveRef = useRef(isActive);
  const focusedRef = useRef(isFocused);
  const firstFocusRef = useRef(true);

  useEffect(() => {
    focusedRef.current = isFocused;
  }, [isFocused]);

  useEffect(() => {
    if (!wasActiveRef.current && isActive && focusedRef.current) {
      for (const queryKey of queryKeysRef.current) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
    wasActiveRef.current = isActive;
  }, [isActive, queryClient]);

  useFocusEffect(
    useCallback(() => {
      if (firstFocusRef.current) {
        firstFocusRef.current = false;
        return;
      }
      for (const queryKey of queryKeysRef.current) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }, [queryClient])
  );
}
