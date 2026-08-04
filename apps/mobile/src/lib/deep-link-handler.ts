import { type Href, router } from 'expo-router';

import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

import { setPendingDeepLink, wasLaunchLinkHandled } from './deep-link-launch';
import { parseGitHubReturnParams, setGitHubInstallReturnOutcome } from './github-install-return';

/** Target app path for the /cloud/sessions universal-link route. */
const AGENTS_TAB_HREF = '/(app)/(tabs)/(2_agents)';

/**
 * Extract the query portion of a raw URL so C13 return-outcome params can be
 * stored before `resolveIncomingUrl` strips them.
 */
function getQueryFromRaw(raw: string): string | null {
  const q = raw.indexOf('?');
  if (q < 0) return null;
  let end = raw.length;
  const h = raw.indexOf('#');
  if (h >= 0 && h < end) end = h;
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
    const href = resolveIncomingUrl(path);
    // Untouched → default handling (and future share intent).
    if (href == null) {
      return path;
    }

    // C13 return-outcome: extract query params before resolveIncomingUrl
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

    if (initial) {
      // COLD: stash only. Never navigate — router isn't mounted.
      // Skip when the synchronous launch capture already stashed this launch
      // URL: expo-router's cold path can land AFTER the gate effect consumed
      // the slot, and a restash would surface as a duplicate navigation on a
      // later, unrelated effect re-run (e.g. token refresh).
      if (!wasLaunchLinkHandled()) {
        setPendingDeepLink(href, 'universal-link');
      }
    } else {
      // WARM: router is mounted; group hrefs work here.
      router.navigate(href as Href);
    }
    // Falsy in both handled cases — critical (see above).
    return null;
  } catch {
    // A deep-link bug must never brick app launch.
    return path;
  }
}
