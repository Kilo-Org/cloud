import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

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
  const navigation = useNavigation();

  // Keep the latest keys in a ref so the focus effect callback stays stable:
  // the owner passes an inline array literal, which is a fresh reference every
  // render, and a changing useFocusEffect callback would re-run on every render.
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;

  const firstFocusRef = useRef(true);

  // Subscribe to AppState directly and read focus live via
  // `navigation.isFocused()`. A blurred tab is frozen, so it does not
  // rerender: a focus value carried through React state or a ref updated in
  // an effect stays stale at `true` and would refresh an unfocused route.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || !navigation.isFocused()) {
        return;
      }
      for (const queryKey of queryKeysRef.current) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
    return () => {
      subscription.remove();
    };
  }, [navigation, queryClient]);

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
