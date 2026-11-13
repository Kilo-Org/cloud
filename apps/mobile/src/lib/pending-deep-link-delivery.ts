import { type PendingDeepLinkArrival } from './deep-link-launch';
import { SESSION_ROUTE_SIBLINGS } from './deep-link-destination';
import { profileScreenPath } from './profile-route-stack';
import { SESSION_HREF_PREFIX } from './system-search-families';

/**
 * Whether the pending destination may navigate, given where the person is.
 *
 * A destination the person chose while this process ran — a link, a
 * notification tap, a launcher shortcut, an action URL — always opens, wherever
 * they are: they asked for it a moment ago.
 *
 * A destination the app recovered for itself is stale by construction. The
 * cold-launch capture replays the OS launch Intent, which also starts a task
 * recreated after process death, and the durable record was written by an
 * earlier process. Either can land after the shell is up and the person has
 * already moved on, so it must not push itself over the screen they opened.
 *
 * Two cases still deliver a recovered destination. One is the app's landing
 * route, where nobody has chosen anything yet. The other is the destination
 * already being the current path: a cold launch that restored its own base
 * Intent has the app there before the slot is consumed, and that navigation is
 * the one `withAnchor` exists for — it inserts each Stack's layout anchor
 * beneath the target so Back returns to the tab's own root (see
 * `deep-link-destination.ts`). Both sides are compared in the form the router
 * reports a pathname — `profileScreenPath` drops every group segment and the
 * query — so a tab-grouped href, a layout group and a `?at=` resume anchor do
 * not make the same destination look like a different one.
 */
export function shouldDeliverPendingDeepLink(input: {
  readonly arrival: PendingDeepLinkArrival;
  readonly href: string;
  readonly atLandingRoute: boolean;
  readonly pathname: string;
}): boolean {
  if (input.arrival === 'live') {
    return true;
  }
  return input.atLandingRoute || profileScreenPath(input.href) === input.pathname;
}

/**
 * Whether an href names the session route, and so can end on the session
 * screen's not-found card. A recovered destination is marked for that screen
 * before it opens, so a session the server no longer has leaves by itself
 * instead of holding a dead end. The mark is one-shot and taken by the first
 * screen that asks, so it is set only for a destination that screen renders:
 * marking anything else would let a later tap on a deleted session fall back to
 * the start screen instead of showing its own answer.
 */
export function isSessionDestinationHref(href: string): boolean {
  if (!href.startsWith(SESSION_HREF_PREFIX)) {
    return false;
  }
  const rest = href.slice(SESSION_HREF_PREFIX.length);
  const capture = rest.slice(0, rest.search(/[?#/]/) === -1 ? rest.length : rest.search(/[?#/]/));
  // `new` is the composer the session route itself answers, and the sibling
  // screens are pickers expo-router matches ahead of `[session-id]`.
  return capture !== 'new' && !SESSION_ROUTE_SIBLINGS.includes(capture);
}
