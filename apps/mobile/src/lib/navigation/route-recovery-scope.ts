/**
 * The navigation object of one route screen, as far as this registry is
 * concerned: the identity of the route. `useNavigation()` returns the same
 * object inside a screen and inside its render-recovery fallback, and the
 * registry never calls into it.
 */
type RouteNavigation = { readonly isFocused: () => boolean };

/**
 * The query scope a route declared for itself, kept so its render-recovery
 * boundary can refetch before remounting it.
 *
 * A route that fails to render because a cached payload poisoned the render
 * would throw again on a plain remount against the same cache. `Retry` on the
 * recovery fallback therefore refetches the queries the route reads first. The
 * route already declares exactly those keys: `useRouteForegroundRefresh` names
 * the tRPC roots it refreshes when the route regains foreground, and those are
 * the reads its screens render. The hook records them here, keyed by the
 * route's navigation object, which the fallback also reads through
 * `useNavigation()`.
 *
 * The map only grows: an entry lives as long as its navigator holds the
 * navigation object. A screen that throws unmounts before the fallback renders,
 * so a cleanup would erase the scope exactly when the fallback needs it.
 */
const recoveryScopes = new WeakMap<RouteNavigation, readonly (readonly unknown[])[]>();

export function setRouteRecoveryScope(
  navigation: RouteNavigation,
  queryPrefixes: readonly (readonly unknown[])[]
): void {
  recoveryScopes.set(navigation, queryPrefixes);
}

/**
 * The route's declared scope, or an empty list when it declared none. An empty
 * list makes `Retry` a plain remount, which never bursts unrelated reads.
 */
export function getRouteRecoveryScope(
  navigation: RouteNavigation
): readonly (readonly unknown[])[] {
  return recoveryScopes.get(navigation) ?? [];
}
