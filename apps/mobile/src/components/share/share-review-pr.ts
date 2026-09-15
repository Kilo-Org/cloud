import { type ProviderPrRef } from '@kilocode/app-shared/provider-review';

import { findFirstProviderPrUrl } from '@/lib/pr-review/provider-pr-url';

/**
 * Decide whether the share gate shows the Review PR destination. The option is
 * visible only when the feature flag is on, the gate would otherwise offer a
 * New session (not a stale-share / all-rejected terminal state), and the staged
 * text contains a parseable GitHub, GitLab or Bitbucket review URL. Parsing
 * routes through the one provider URL resolver, so a GitLab merge request and
 * a Bitbucket pull request are recognised exactly like a GitHub PR.
 */
export function selectShareReviewPr(input: {
  text: string;
  prReviewEnabled: boolean;
  showNewSession: boolean;
}): ProviderPrRef | null {
  if (!input.prReviewEnabled || !input.showNewSession) {
    return null;
  }
  return findFirstProviderPrUrl(input.text);
}
