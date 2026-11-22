import { type PendingDeepLinkArrival } from './deep-link-launch';
import { SESSION_ROUTE_SIBLINGS } from './deep-link-destination';
import { normalizedRoutePath } from './last-route-repair';
import { SESSION_HREF_PREFIX } from './system-search-families';

/**
 * Whether the pending destination may navigate, given where the person is.
 *
 * A destination the person chose while this process ran — a link, a
 * notification tap, a launcher shortcut, an action URL — always opens, wherever
 * they are: they asked for it a moment ago.
 *
 * A destination the app recovered for itself has two producers, and both are
 * stale by construction. The cold-launch capture (`captureLaunchDeepLink`)
 * replays the OS launch Intent, which also starts a task recreated after
 * process death. The durable restart record (`restorePersistedPendingDeepLink`)
 * was written by an earlier process. Either can land after the shell is up and
 * the person has already moved on, so it must not push itself over the screen
 * they opened.
 *
 * The producers part company at the app's landing route, where nobody has
 * chosen anything yet. Only the launch capture still opens there: it is the
 * story of a genuine launch into a link, the screen this process was started
 * for. The restart record is not, so it is dropped there unless the person is
 * already on the destination.
 *
 * Two cases still deliver a recovered destination. One is the launch capture at
 * the landing route above. The other is the destination already being the
 * current route: a cold launch that restored its own base Intent has the app
 * there before the slot is consumed, and that navigation is the one `withAnchor`
 * exists for — it inserts each Stack's layout anchor beneath the target so Back
 * returns to the tab's own root (see `deep-link-destination.ts`).
 *
 * The comparison runs on the route's own segments, from `useSegments`, not on
 * the pathname: a parenthesised segment names a destination — which tab is
 * focused — and the pathname drops every group, so all four tab roots would
 * read as `/`. `normalizedRoutePath` keeps a tab segment on both sides while it
 * drops the layout groups (`(app)`, `(auth)`, `(tabs)`) and the query, so two
 * different tabs stay different and a `?at=` resume anchor does not make the
 * same session look like another one.
 */
export function shouldDeliverPendingDeepLink(input: {
  readonly arrival: PendingDeepLinkArrival;
  readonly href: string;
  readonly atLandingRoute: boolean;
  readonly segments: readonly string[];
  /**
   * Whether `href` is the href the cold-launch capture stashed
   * (`wasLaunchLinkHandled`), that is, the story of a genuine launch into a
   * link rather than a record an earlier process left behind. Read only for a
   * restored arrival: a live one is delivered before this is consulted.
   */
  readonly fromLaunchCapture: boolean;
}): boolean {
  if (input.arrival === 'live') {
    return true;
  }
  const currentRoute = normalizedRoutePath(`/${input.segments.join('/')}`);
  const alreadyShowing = normalizedRoutePath(input.href) === currentRoute;
  if (input.atLandingRoute) {
    // The landing route only opens a link this process was launched into; a
    // restart record has to be where the person already is.
    return input.fromLaunchCapture || alreadyShowing;
  }
  return alreadyShowing;
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
