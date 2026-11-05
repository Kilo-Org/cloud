import { router } from 'expo-router';

// Development-only entry for the PR-review copy surfaces, reached through the
// app's own link scheme and the dev fixture prefix below.
//
// It navigates itself and reports the link as handled, the way the GitLab
// instance fixture does: a link that returns a route to the resolver is
// re-dispatched and races a reset to the tabs root, which lands the reader on
// Home instead of the surface. The link's own query rides along, because the
// submit surface reads the PR triple from it.

const FIXTURE_PATH = /(?:^|\/)dev\/pr-review-copy-fixture\/([a-z0-9-]+)\/?(?:\?([^#]*))?(?:#.*)?$/;

const SURFACES = [
  'tabs',
  'checks',
  'navigator',
  'files',
  'merge',
  'submit',
  'checks-not-available',
  'composer',
  'gate-github-error',
  'gate-gitlab-error',
  'gate-bitbucket-error',
  'gate-gitlab-admin-only',
  'overview',
  'overview-no-checks',
  'overview-multi-group',
  'overview-blocked',
  'overview-merged',
  'overview-auto-merge',
  'merge-request',
  'merge-request-missing',
  'merge-request-error',
] as const;

/**
 * Handle a fixture link. True when the path names one of the fixture's
 * surfaces (navigated, so the caller returns falsy and nothing else resolves
 * the link).
 */
export function handlePrReviewCopyFixturePath(path: string): boolean {
  const match = FIXTURE_PATH.exec(path);
  if (!match) {
    return false;
  }
  const surface = match[1];
  if (!SURFACES.some(candidate => candidate === surface)) {
    return false;
  }
  const extras = match[2] ? `&${match[2]}` : '';
  // `router` queues the navigation when the router is not mounted yet, so a
  // cold delivery still lands.
  router.replace(`/(auth)/pr-review-copy-fixture?surface=${surface}${extras}`);
  return true;
}
