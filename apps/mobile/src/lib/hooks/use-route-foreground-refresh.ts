import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { setRouteRecoveryScope } from '@/lib/navigation/route-recovery-scope';

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
 *
 * The keys double as the route's render-recovery scope unless the caller is a
 * mount whose keys are app-wide rather than the render payloads of one route
 * (`recoveryScope: false`): the recovery fallback must not refetch the whole
 * app's freshness for a screen that reads none of it.
 */
export function useRouteForegroundRefresh(
  queryKeys: readonly (readonly unknown[])[],
  options: { recoveryScope?: boolean } = {}
): void {
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const recoveryScope = options.recoveryScope ?? true;

  // Keep the latest keys in a ref so the focus effect callback stays stable:
  // the owner passes an inline array literal, which is a fresh reference every
  // render, and a changing useFocusEffect callback would re-run on every render.
  const queryKeysRef = useRef(queryKeys);
  queryKeysRef.current = queryKeys;

  // The same keys are this route's render-recovery scope: when a screen of the
  // route throws while rendering one of these payloads, the recovery fallback
  // refetches them before remounting, so the throw is not replayed against the
  // cache. Recorded during render, not in an effect, because the screen that
  // needs it can throw on its first render (a persisted, poisoned cache) and
  // would then never commit the effect. The write is an idempotent entry in a
  // WeakMap keyed by this route's navigation object, derived only from the
  // hook's arguments, and the boundary reads it back for the same object.
  if (recoveryScope) {
    setRouteRecoveryScope(navigation, queryKeys);
  }

  const firstFocusRef = useRef(true);

  // Subscribe to AppState directly and read focus live via
  // `navigation.isFocused()`. A focus value carried through React state or a
  // ref updated in an effect lags the navigation state, so it can still read
  // `true` for a route that has lost focus and would refresh an unfocused
  // route.
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

/**
 * App-wide freshness: the same foreground refresh, without a render-recovery
 * scope. These keys are the whole app's freshness rather than one route's
 * render payloads, so a route screen that declared no reads of its own remounts
 * instead of refetching them.
 */
export function useAppWideForegroundRefresh(queryKeys: readonly (readonly unknown[])[]): void {
  useRouteForegroundRefresh(queryKeys, { recoveryScope: false });
}
