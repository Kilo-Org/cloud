/**
 * The navigation object of one route, as far as this registry is concerned: the
 * identity of the route and the way to its enclosing routes. `useNavigation()`
 * returns the same object inside a screen and inside its render-recovery
 * fallback, and the registry never calls into it beyond that chain.
 */
type RouteNavigation = {
  readonly isFocused: () => boolean;
  readonly getParent: () => RouteNavigation | undefined;
};

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
 * `useNavigation()`. A layout records the scope for the screens it hosts, and a
 * screen without a declaration of its own inherits it through its navigation
 * chain.
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
 * The scope of the nearest route that declared one, starting at `navigation`.
 *
 * A nested layout declares the reads of the screens it hosts (a PR-review tree,
 * say), and its screens inherit that scope: their own navigation object declared
 * nothing, and walking to the enclosing route is what finds the layout's
 * declaration. The walk stops at the first declarer, so a screen never refetches
 * a wider scope than the one that covers it, and an empty list makes `Retry` a
 * plain remount that bursts nothing.
 */
export function getRouteRecoveryScope(
  navigation: RouteNavigation
): readonly (readonly unknown[])[] {
  const visited = new Set<RouteNavigation>();
  let current: RouteNavigation | undefined = navigation;
  // A cyclic chain would otherwise spin the render path; the set bounds the
  // walk to the real depth of the navigators.
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const declared = recoveryScopes.get(current);
    if (declared !== undefined) {
      return declared;
    }
    current = current.getParent();
  }
  return [];
}
