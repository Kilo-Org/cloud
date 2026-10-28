/**
 * Which concrete route paths may be recorded as the relaunch-restore target.
 *
 * The record exists to repair a cold start whose base Intent replays a stale
 * deep link (Android task restore): the app should reopen on the screen the
 * person actually had focused. Only real in-app surfaces qualify — bootstrap
 * and gate routes own the screen while they are up, and a record captured on
 * one of them would send the next launch back into a gate the bootstrap
 * already resolves on its own.
 *
 * `pathname` is the concrete Expo Router path from `usePathname()` (e.g.
 * `/agent-chat/ses_1`), without group segments. `segments` is the
 * `useSegments()` array, which keeps the group names.
 */
export function isRecordableLastRoute(pathname: string, segments: readonly string[]): boolean {
  if (segments.length === 0 || segments[0] !== '(app)') {
    return false;
  }
  // Gate and flow-control surfaces: the bootstrap gates (consent, force
  // update), the share gate, the post-sign-in tour/onboarding, and the pickers
  // that ride an RTL language reload own their screens transiently. A record
  // captured there would reopen a flow the next launch either resolves on its
  // own (bootstrap gates) or cannot complete without its originating context
  // (a picker or gate opened on top of another screen).
  const unrecordable = [
    '/consent',
    '/consent-details',
    '/language-picker',
    '/force-update',
    '/share-gate',
    '/onboarding',
    '/tour',
    '/kilo-pass',
  ];
  if (unrecordable.includes(pathname)) {
    return false;
  }
  // The auth group is unreachable with `(app)` first, but the segments guard
  // above is the real check; this only names the auth layout's own children.
  if (segments.includes('(auth)')) {
    return false;
  }
  return true;
}

/**
 * Whether an href is a concrete destination rather than a route pattern.
 *
 * `useSegments()` reports dynamic segments as their pattern (`[profileId]`,
 * `[sessionId]`), so an href assembled from it navigates to a literal
 * placeholder and the restored screen's data reads fail. Only a concrete href
 * may be recorded, and a record that predates this rule is dropped on read.
 */
export function isConcreteLastRouteHref(href: string): boolean {
  return href.length > 0 && !href.includes('[');
}

/** expo-router's own launch flag on the global href, not screen state. */
const ROUTER_INTERNAL_PARAM = 'initial=';

/** A query value that never resolved past a route pattern (`[profileId]`). */
function isPlaceholderPair(pair: string): boolean {
  const separator = pair.indexOf('=');
  const value = separator === -1 ? '' : pair.slice(separator + 1);
  return value.includes('[') || value.includes('%5B');
}

/**
 * The href `router.navigate` reopens the focused screen with.
 *
 * The path comes from the segment list when every segment is concrete: it is
 * the only source that keeps the tab-group identity (`/(app)/(tabs)/(3_profile)`
 * rather than `/`), so the app reopens on the tab the person left. Dynamic
 * segments stay a pattern (`profiles/[profileId]/variables`) and read as
 * unusable here, so the router's global href — the concrete path it resolved,
 * with the query the screen was opened with — supplies the path then.
 *
 * The query comes from the global href, minus expo-router's own launch flag and
 * minus pairs that still carry a route pattern. Returns null when no source
 * names a concrete route (the layout can commit before any route resolves).
 */
export function lastRouteHrefFrom(
  globalHref: string,
  pathname: string,
  segments: readonly string[]
): string | null {
  const grouped = segments.filter(part => part.length > 0);
  const fromSegments = grouped.length > 0 ? `/${grouped.join('/')}` : '';
  const queryStart = globalHref.indexOf('?');
  const globalPath = queryStart === -1 ? globalHref : globalHref.slice(0, queryStart);
  const path = [fromSegments, globalPath, pathname].find(candidate =>
    isConcreteLastRouteHref(candidate)
  );
  if (path === undefined) {
    return null;
  }
  const kept =
    queryStart === -1
      ? []
      : globalHref
          .slice(queryStart + 1)
          .split('&')
          .filter(
            pair =>
              pair.length > 0 && !pair.startsWith(ROUTER_INTERNAL_PARAM) && !isPlaceholderPair(pair)
          );
  return kept.length > 0 ? `${path}?${kept.join('&')}` : path;
}
