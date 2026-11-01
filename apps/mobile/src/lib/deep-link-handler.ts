import { resolveIncomingResume } from '@kilocode/app-shared/universal-links';

import { opensAppRoutePath, opensDestination, shellRouteHref } from './deep-link-destination';
import { resumeDeepLinkHref, setPendingDeepLink, wasLaunchLinkHandled } from './deep-link-launch';
import { parseGitHubReturnParams, setGitHubInstallReturnOutcome } from './github-install-return';
import { isSystemSearchFamilyLink } from './system-search-families';

/** Target app path for the /cloud/sessions universal-link route. */
const AGENTS_TAB_HREF = '/(app)/(tabs)/(2_agents)';

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
      // A link that opens a screen inside the signed-in shell travels the same
      // way a universal link does: stashed, then navigated by the root layout
      // with `withAnchor`, which puts each Stack's layout anchor beneath the
      // target. Handing it to expo-router's resolver instead builds the target
      // as its stack's only route, so Back leaves the tab and the tab itself
      // reopens the linked screen (see `shellRouteHref`).
      const shellRoute = shellRouteHref(path);
      if (shellRoute !== null) {
        setPendingDeepLink(shellRoute, 'universal-link');
        return null;
      }
      return opensAppRoutePath(path) ? path : null;
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
