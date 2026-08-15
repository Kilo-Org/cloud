import { type Href } from 'expo-router';

import { parseGitHubPrUrl } from '@/lib/github-pr-url';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';

export type SessionPrNavigationInput = Readonly<{
  /** Host of the linked PR (`github`, `gitlab`, …). */
  platform: string | null | undefined;
  /** PR HTML URL, e.g. `https://github.com/org/repo/pull/123`. */
  url: string | null | undefined;
  /** PR number. */
  number: number;
}>;

export type SessionPrNavigationResult =
  | { kind: 'in-app'; href: Href }
  | { kind: 'browser'; url: string };

/**
 * Decide where tapping a session's PR badge navigates.
 *
 * GitHub PRs open the in-app review screen; everything else opens the browser.
 * The in-app route needs `owner` and `repo`, which only a parseable
 * `github.com` URL carries. A `github` platform signal therefore still falls
 * back to the browser when the URL cannot be parsed (Enterprise hosts, links,
 * malformed URLs), because no in-app path can be built.
 */
export function resolveSessionPrTapTarget(
  input: SessionPrNavigationInput
): SessionPrNavigationResult {
  const url = input.url;
  const parsed = typeof url === 'string' && url.length > 0 ? parseGitHubPrUrl(url) : null;

  if (parsed) {
    return { kind: 'in-app', href: getPrReviewPath(parsed.owner, parsed.repo, input.number) };
  }
  return { kind: 'browser', url: url ?? '' };
}
