import { router } from 'expo-router';

import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';

/**
 * Development-only entry for the connect gate's GitLab-instance state.
 *
 * It opens the same route the paste flow opens — a provider merge request with
 * the pasted URL's `?instance=` hint — through the same navigation the entry
 * screen performs. A link that returns a route to the resolver is re-dispatched
 * and races a reset to the tabs root, so this one navigates itself and reports
 * the link as handled (`+native-intent.tsx` returns falsy for it). A system link
 * cannot carry the hint: the resolver drops a link's query before the route
 * reads it. The link is the app scheme's dev path named by the pattern below.
 */

const FIXTURE_PATH = /(?:^|\/)dev\/pr-review-gitlab-instance-fixture\/?$/;

/** A self-managed instance, which no gitlab.com connection can serve. */
const FIXTURE_REF = {
  platform: 'gitlab',
  projectPath: 'sample/platform/engineering/a-repository-with-a-long-name',
  mrIid: 18,
  instanceHint: 'https://gitlab.example.com',
} as const;

/**
 * Handle a fixture link. True when the path is this fixture (handled, so the
 * caller returns falsy and nothing else resolves the link).
 */
export function handlePrReviewInstanceFixturePath(path: string): boolean {
  if (!FIXTURE_PATH.test(path)) {
    return false;
  }
  // `router` queues the navigation when the router is not mounted yet, so a
  // cold delivery still lands.
  router.replace(providerPrRoutePath(FIXTURE_REF));
  return true;
}
