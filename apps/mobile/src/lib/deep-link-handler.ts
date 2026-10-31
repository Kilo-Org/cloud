import { parseKiloWebPath, resolveIncomingResume } from '@kilocode/app-shared/universal-links';

import { resumeDeepLinkHref, setPendingDeepLink, wasLaunchLinkHandled } from './deep-link-launch';
import { parseGitHubReturnParams, setGitHubInstallReturnOutcome } from './github-install-return';
import { isPlausibleKiloSessionId } from './session-id-shape';
import { INDEXED_LINK_PREFIXES, isSystemSearchFamilyLink } from './system-search-families';

/** Target app path for the /cloud/sessions universal-link route. */
const AGENTS_TAB_HREF = '/(app)/(tabs)/(2_agents)';

/**
 * Root entries of `src/app` a link may address directly: the two route groups
 * and the root-level screens. The universal-link table routes the app's
 * published links; these are the in-app routes a dev or E2E link opens
 * (`kiloapp:///(app)/…`, `kiloapp:///force-update`).
 *
 * Anything outside this set and the indexed families below names no screen the
 * app can open, so it is ignored rather than handed to the navigator (see
 * `redirectSystemPath`). `deep-link-handler.test.ts` keeps the list equal to the
 * route directory's entries.
 */
export const APP_ROUTE_ROOTS: readonly string[] = [
  '(app)',
  '(auth)',
  'button-label-fixture',
  'force-update',
];

/** Prefix of the session-detail row's app target (`UNIVERSAL_LINK_ROUTES`). */
const SESSION_HREF_PREFIX = '/(app)/agent-chat/';

/** The one session capture that opens the composer instead of a session. */
const NEW_SESSION_CAPTURE = 'new';

/**
 * Extract the query portion of a raw URL so C13 return-outcome params can be
 * stored before `resolveIncomingUrl` strips them.
 */
function getQueryFromRaw(raw: string): string | null {
  const q = raw.indexOf('?');
  if (q === -1) {
    return null;
  }
  let end = raw.length;
  const h = raw.indexOf('#');
  if (h !== -1 && h < end) {
    end = h;
  }
  return raw.slice(q, end);
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
 * Whether a link addresses the app's own route namespace. A dev or E2E link
 * carries the route with its group segment (`kiloapp:///(app)/…`, the form the
 * design gate and the mobile docs use); a system-search tap is delivered as the
 * group-stripped family link the app itself indexed (`kiloapp://agent-chat/…`).
 */
function addressesAppRoute(path: string): boolean {
  const pathname = pathnameOf(path);
  if (pathname === null) {
    return false;
  }
  const withoutLeadingSlash = pathname.replace(/^\/+/, '');
  if (INDEXED_LINK_PREFIXES.some(prefix => withoutLeadingSlash.startsWith(prefix))) {
    return true;
  }
  const root = withoutLeadingSlash.split('/')[0];
  return root !== undefined && APP_ROUTE_ROOTS.includes(root);
}

/**
 * Whether a table destination opens something the app can show. A session
 * target must carry a session id the route can resolve — `new` is the composer,
 * and `isPlausibleKiloSessionId` is the same shape guard the session route uses
 * before it decides an id can never be a session.
 */
function opensDestination(href: string): boolean {
  if (!href.startsWith(SESSION_HREF_PREFIX)) {
    return true;
  }
  const capture = href.slice(SESSION_HREF_PREFIX.length);
  return capture === NEW_SESSION_CAPTURE || isPlausibleKiloSessionId(capture);
}

/**
 * expo-router `+native-intent` `redirectSystemPath` implementation.
 *
 * Load-bearing facts (past critical findings):
 * 1. SYNCHRONOUS — expo-router's cold path assigns the result without `await`.
 * 2. Must return FALSY for handled links — a truthy return re-dispatches the
 *    linking resolver and races our navigation against a reset-to-Home.
 *    Returning `'/'` is a bug that looks like success on tab-root rows.
 * 3. `initial` is the cold/warm discriminator — never try/catch around navigate
 *    as a readiness probe; `router.navigate` queues rather than throws when the
 *    router is unmounted, so try/catch silently drops cold deep links.
 * 4. A link that names no screen the app can open returns FALSY, like a handled
 *    one: the resolver must not run for it, because resolving a link replaces
 *    the visible route and unmounts the screen beneath it, losing unsaved state.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    const resume = resolveIncomingResume(path);
    // Not a universal-link route: only the app's own route namespace reaches the
    // navigator. Anything else (a bare `kiloapp:///`, an unknown path, another
    // host) names no screen, and handing it over would replace the current
    // screen — and with it unsaved state such as an open form — with whatever
    // the resolver makes of it. A link that opens nothing leaves the screen be.
    if (resume == null) {
      return addressesAppRoute(path) ? path : null;
    }
    const { href, anchorMessageId } = resume;
    // A table route that cannot open its destination is not a link either: the
    // session row accepts any capture, and the session route answers an id that
    // can never be a session with the composer, which is not what the link
    // named and not a reason to leave the current screen.
    if (!opensDestination(href)) {
      return null;
    }
    // A resume link carries `?at=<message id>`: stash it on the href so the
    // session screen can land on the recorded position. Links without an
    // anchor keep their href byte-identical (the AGENTS_TAB_HREF check below
    // compares against the un-suffixed href on purpose). The synchronous
    // launch capture formats its stash through the same helper.
    const stashHref = resumeDeepLinkHref({ href, anchorMessageId });

    // C13 return-outcome: extract query params before resolveIncomingResume
    // strips them.  Store so the agents tab can show the outcome state.
    if (href === AGENTS_TAB_HREF) {
      const query = getQueryFromRaw(path);
      if (query) {
        const outcome = parseGitHubReturnParams(query);
        if (outcome) {
          setGitHubInstallReturnOutcome(outcome);
        }
      }
    }

    // An app-scheme URL that names a family the phone's search indexes is a
    // system-search result's identifier (the app scheme is how Android
    // delivers the tap), so it is bound to the session that indexed it and
    // must not open for another account. An `https://` link stays
    // account-independent.
    const sessionBound = isSystemSearchFamilyLink(path);

    if (initial) {
      // COLD: stash only. Never navigate — router isn't mounted.
      // Skip when the synchronous launch capture already stashed this launch
      // URL: expo-router's cold path can land AFTER the gate effect consumed
      // the slot, and a restash would surface as a duplicate navigation on a
      // later, unrelated effect re-run (e.g. token refresh).
      if (!wasLaunchLinkHandled()) {
        setPendingDeepLink(stashHref, 'universal-link', { sessionBound });
      }
    } else {
      // WARM: stash like the cold path. The layout consumer navigates once the
      // shell is ready, so a signed-out warm https link survives login; a
      // session-bound one is dropped by the slot's account rules instead.
      setPendingDeepLink(stashHref, 'universal-link', { sessionBound });
    }
    // Falsy in both handled cases — critical (see above).
    return null;
  } catch {
    // A deep-link bug must never brick app launch.
    return path;
  }
}
