import { type Href, type NativeStackNavigationProp, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

/**
 * The `router.replace` call signature, so helpers that already take a router
 * (`replaceWithAgentSession` and friends) accept this hook's result unchanged.
 */
export type StackSafeReplaceRouter = {
  replace: (href: Href) => void;
};

/**
 * A `router.replace` that the Android native stack survives.
 *
 * `router.replace` removes the current screen and inserts the next one in a
 * single native-stack commit. On Android, react-native-screens reparents a view
 * the outgoing screen still owns during that commit and Fabric throws
 * `addViewAt: failed to insert view [...] The specified child already has a
 * parent` (Sentry KILO-APP-25). A plain `push` and a plain `pop` each commit
 * cleanly; only the combined swap breaks.
 *
 * So push, then drop the route we came from once its transition has ended. That
 * route is no longer the visible screen by then, so removing it animates nothing
 * and commits on its own. The end state is the one `replace` produces: the source
 * screen is gone and back skips past it.
 *
 * Waiting for `transitionEnd` is what makes the second commit safe. The earlier
 * form of this pushed and then reset the stack one frame later, which landed the
 * second commit while the push was still animating and crashed the same way.
 *
 * The removal is keyed on the route focused when the navigation started, so a
 * duplicate route name elsewhere in the stack is never dropped by mistake.
 */
export function useStackSafeReplace(): StackSafeReplaceRouter {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, undefined>>>();
  const pendingRouteKeyRef = useRef<string | null>(null);

  useEffect(
    () =>
      navigation.addListener('transitionEnd', () => {
        const routeKey = pendingRouteKeyRef.current;
        if (routeKey === null) {
          return;
        }
        pendingRouteKeyRef.current = null;
        const state = navigation.getState();
        const routes = state.routes.filter(route => route.key !== routeKey);
        // The route is already gone (the user left another way), or it is the
        // only one left: leave the stack alone rather than commit a bad reset.
        if (routes.length === state.routes.length || routes.length === 0) {
          return;
        }
        navigation.reset({ ...state, routes, index: routes.length - 1 });
      }),
    [navigation]
  );

  const replace = useCallback(
    (href: Href) => {
      const state = navigation.getState();
      pendingRouteKeyRef.current = state.routes[state.index]?.key ?? null;
      router.push(href);
    },
    [navigation, router]
  );

  return { replace };
}
