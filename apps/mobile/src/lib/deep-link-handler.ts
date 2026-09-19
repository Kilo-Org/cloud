import { resolveIncomingResume } from '@kilocode/app-shared/universal-links';

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
    // Untouched → default handling (and future share intent).
    if (resume == null) {
      return path;
    }
    const { href, anchorMessageId } = resume;
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
