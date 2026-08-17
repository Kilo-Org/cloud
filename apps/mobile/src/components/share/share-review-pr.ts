import { findFirstGitHubPrUrl, type GitHubPrUrl } from '@/lib/github-pr-url';

/**
 * Decide whether the share gate shows the Review PR destination. The option is
 * visible only when the feature flag is on, the gate would otherwise offer a
 * New session (not a stale-share / all-rejected terminal state), and the staged
 * text contains a parseable github.com PR URL.
 */
export function selectShareReviewPr(input: {
  text: string;
  prReviewEnabled: boolean;
  showNewSession: boolean;
}): GitHubPrUrl | null {
  if (!input.prReviewEnabled || !input.showNewSession) {
    return null;
  }
  return findFirstGitHubPrUrl(input.text);
}
