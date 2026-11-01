/**
 * Dev-only fixture for the Security Agent stack state a fresh destination
 * produces.
 *
 * `kiloapp:///dev/security-agent-single-route-fixture/<scope>/<route…>` opens
 * the `[scope]` screen named by the rest of the path (for example
 * `.../dev/security-agent-single-route-fixture/personal/settings/notifications`)
 * the way a link that builds its destination lands: the screen becomes the
 * Security Agent group's ONLY route, with no dashboard beneath it. Back from
 * that screen is what the fixture exists to exercise.
 *
 * The only entry point is `+native-intent.tsx`, behind `__DEV__`.
 */

const FIXTURE_PATH =
  /(?:^|\/)dev\/security-agent-single-route-fixture\/([^/?#]+)(?:\/([^?#]*))?(?:[?#].*)?$/;

/**
 * The dev route that mounts the fixture, or null when the path is not this
 * fixture's link.
 */
export function securityAgentSingleRouteFixtureRoute(path: string): string | null {
  const match = FIXTURE_PATH.exec(path);
  const scope = match?.[1];
  if (scope === undefined) {
    return null;
  }
  const suffix = (match?.[2] ?? '').replace(/\/+$/, '');
  const suffixParam = suffix === '' ? '' : `&suffix=${encodeURIComponent(suffix)}`;
  return `/security-agent-single-route-fixture?scope=${encodeURIComponent(scope)}${suffixParam}`;
}
