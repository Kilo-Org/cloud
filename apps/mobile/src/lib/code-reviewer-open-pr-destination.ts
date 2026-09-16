import { type Href } from 'expo-router';

import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';
import { parseProviderPrUrl } from '@/lib/pr-review/provider-pr-url';

type CodeReviewerOpenPrDestination = { kind: 'in-app'; href: Href } | { kind: 'browser' };

/**
 * Decide whether "Open pull request" should navigate in-app or open the browser.
 *
 * In-app only when the PR-review feature flag is on and `prUrl` names a review
 * the provider routes serve: a github.com pull request, a GitLab merge request
 * (gitlab.com or a self-managed host) or a Bitbucket pull request. The URL
 * parses through the one provider resolver and the path comes from the one
 * provider route builder, so all three providers land on the same screen tree.
 * Anything else (flag off, GitHub Enterprise, malformed) keeps the browser path.
 */
export function resolveCodeReviewerOpenPrDestination(
  prUrl: string,
  prReviewEnabled: boolean
): CodeReviewerOpenPrDestination {
  if (!prReviewEnabled) {
    return { kind: 'browser' };
  }
  const ref = parseProviderPrUrl(prUrl);
  if (!ref) {
    return { kind: 'browser' };
  }
  return { kind: 'in-app', href: providerPrRoutePath(ref) };
}
