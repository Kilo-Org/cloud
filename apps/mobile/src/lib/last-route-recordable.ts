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
