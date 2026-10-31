/**
 * What an incoming link may open.
 *
 * A link that names no screen the app can show must not reach the navigator:
 * resolving a link replaces the visible route and unmounts the screen beneath
 * it, so an open form and its unsaved input are lost even though the link
 * opened nothing anyone asked for. The two consumers are `redirectSystemPath`
 * (a warm arrival, which also forwards the app's own routes) and the
 * synchronous cold-launch capture in `deep-link-launch.ts` (which only needs the
 * table destination). One module owns both answers so they cannot disagree.
 */

import { parseKiloWebPath } from '@kilocode/app-shared/universal-links';

import { isPlausibleKiloSessionId } from './session-id-shape';
import {
  deeplinkPathFromHref,
  INDEXED_LINK_PREFIXES,
  SESSION_HREF_PREFIX,
} from './system-search-families';

/**
 * Root entries of `src/app` a link may address directly: the two route groups
 * and the root-level screens. The universal-link table routes the app's
 * published links; these are the in-app routes a dev or E2E link opens
 * (`kiloapp:///(app)/…`, `kiloapp:///force-update`).
 *
 * `deep-link-destination.test.ts` keeps the list equal to the route
 * directory's entries.
 */
export const APP_ROUTE_ROOTS: readonly string[] = [
  '(app)',
  '(auth)',
  'button-label-fixture',
  'force-update',
];

/** Route param that opens the New-session composer instead of a session. */
const NEW_SESSION_CAPTURE = 'new';

/** The session family's group-stripped prefix, as an indexed link carries it. */
const SESSION_FAMILY_PREFIX = deeplinkPathFromHref(SESSION_HREF_PREFIX);

/**
 * Whether a universal-link destination opens something the app can show. Every
 * row but the session row names a fixed screen; the session row accepts any
 * capture, so its capture has to be the composer's `new` or an id the route can
 * resolve. `isPlausibleKiloSessionId` is the same shape guard the route uses
 * before it decides an id can never be a session.
 */
export function opensDestination(href: string): boolean {
  if (!href.startsWith(SESSION_HREF_PREFIX)) {
    return true;
  }
  const capture = href.slice(SESSION_HREF_PREFIX.length);
  return capture === NEW_SESSION_CAPTURE || isPlausibleKiloSessionId(capture);
}

/**
 * The pathname of a raw link: the path of one of our URL forms, or the
 * scheme-less path expo-router hands `redirectSystemPath`. Null when the link
 * carries no path of ours at all (a bare `kiloapp://`, or another host).
 */
function pathnameOf(path: string): string | null {
  const webPath = parseKiloWebPath(path);
  if (webPath !== null) {
    return webPath;
  }
  if (!path.startsWith('/')) {
    return null;
  }
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * Whether a link addresses the app's own routes — the paths this app, not the
 * web table, owns. A dev or E2E link carries the route with its group segment
 * (`kiloapp:///(app)/…`, the form the design gate and the mobile docs use); a
 * system-search tap is delivered as the group-stripped family link the app
 * itself indexed (`kiloapp://agent-chat/…`). The session route appears in both
 * forms and its param must name a screen either way.
 */
export function opensAppRoutePath(path: string): boolean {
  const pathname = pathnameOf(path);
  if (pathname === null) {
    return false;
  }
  const withoutLeadingSlash = pathname.replace(/^\/+/, '');
  // One href for the session route, whichever form the link carries: with the
  // group segment (dev and E2E links) or without it (a search tap).
  const sessionHref = withoutLeadingSlash.startsWith(SESSION_FAMILY_PREFIX)
    ? `${SESSION_HREF_PREFIX}${withoutLeadingSlash.slice(SESSION_FAMILY_PREFIX.length)}`
    : `/${withoutLeadingSlash}`;
  if (sessionHref.startsWith(SESSION_HREF_PREFIX)) {
    return opensDestination(sessionHref);
  }
  if (INDEXED_LINK_PREFIXES.some(prefix => withoutLeadingSlash.startsWith(prefix))) {
    return true;
  }
  const root = withoutLeadingSlash.split('/')[0];
  return root !== undefined && APP_ROUTE_ROOTS.includes(root);
}
