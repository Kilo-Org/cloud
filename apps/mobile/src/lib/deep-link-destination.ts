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
  APP_SCHEME,
  canonicalSystemSearchId,
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
  'security-agent-single-route-fixture',
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

/** The group whose screens the signed-in shell owns. */
const SHELL_GROUP = '(app)';

/** A link's own path, with its query kept, for the forms that carry one. */
function appHref(path: string): string | null {
  if (path.startsWith('/')) {
    return path;
  }
  if (!path.startsWith(APP_SCHEME)) {
    return null;
  }
  const rest = path.slice(APP_SCHEME.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * The href of a link that opens a screen inside the signed-in shell, or null
 * for every other link.
 *
 * Such a link carries the route with its group segment (`kiloapp:///(app)/…`,
 * the form dev, E2E and fixture links use) and must reach the navigator through
 * the pending deep-link slot, not expo-router's linking resolver: only the
 * slot's `withAnchor` navigation inserts each Stack's layout anchor beneath the
 * target, so Back returns to the tab's own root and the tab shows that root
 * instead of the linked screen. Everything else keeps its own path — an
 * auth-group or root-level link opens a route the shell gates own, and a
 * group-stripped system-search link belongs to the slot the search tap filled.
 */
export function shellRouteHref(path: string): string | null {
  const href = appHref(path);
  if (href === null) {
    return null;
  }
  const pathname = pathnameOf(href);
  if (pathname === null) {
    return null;
  }
  if (pathname !== `/${SHELL_GROUP}` && !pathname.startsWith(`/${SHELL_GROUP}/`)) {
    return null;
  }
  if (!opensDestination(pathname)) {
    return null;
  }
  // A search result indexed before its family moved names its old route. It is
  // still a search tap and not a link handed to the app, so the search slot
  // keeps it.
  return canonicalSystemSearchId(pathname) === pathname ? href : null;
}
