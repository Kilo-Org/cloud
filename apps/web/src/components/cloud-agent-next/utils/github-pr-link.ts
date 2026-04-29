/**
 * Pure helpers that compute the "Open in GitHub" dropdown item for ChatHeader
 * based on the session's git URL, branch, and associated PR (if any).
 */

import { buildRepoBrowseUrl, detectGitPlatform } from './git-utils';

export type AssociatedPr = {
  url: string;
  number: number;
  state: string;
  title: string | null;
  headSha: string | null;
  lastSyncedAt: string;
};

export type PrBadgeState = 'open' | 'closed' | 'merged';

/**
 * Interpret the raw PR state string (as GitHub returns it + our "merged" flag
 * from the webhook) into one of three UI buckets.
 *
 * GitHub state is 'open' or 'closed'; closed-and-merged PRs are surfaced as
 * state 'merged' by the backend refresh endpoint.
 */
export function normalizePrBadgeState(state: string): PrBadgeState {
  if (state === 'merged') return 'merged';
  if (state === 'open') return 'open';
  return 'closed';
}

export type GithubLinkDescriptor =
  | {
      kind: 'pr';
      label: string;
      href: string;
      prState: PrBadgeState;
      prNumber: number;
    }
  | { kind: 'compare'; label: string; href: string }
  | { kind: 'browse'; label: string; href: string }
  | { kind: 'none' };

/**
 * Decide what the primary "Open in GitHub" menu item should look like.
 *
 * Priority:
 *  1. Associated PR (if we have one) wins — label "Open PR #N", href to the PR.
 *  2. GitHub URL + branch → compare URL (unchanged legacy behavior).
 *  3. Non-GitHub git URL → plain repo browse URL.
 *  4. No git URL → no link.
 */
export function resolveGithubLink(options: {
  gitUrl: string | null | undefined;
  branch: string | null | undefined;
  associatedPr: AssociatedPr | null | undefined;
}): GithubLinkDescriptor {
  const { gitUrl, branch, associatedPr } = options;

  if (associatedPr) {
    return {
      kind: 'pr',
      label: `Open PR #${associatedPr.number}`,
      href: associatedPr.url,
      prState: normalizePrBadgeState(associatedPr.state),
      prNumber: associatedPr.number,
    };
  }

  const browseUrl = buildRepoBrowseUrl(gitUrl);
  if (!browseUrl) return { kind: 'none' };

  if (branch && detectGitPlatform(gitUrl) === 'github') {
    return {
      kind: 'compare',
      label: 'Open compare on GitHub',
      href: `${browseUrl}/compare/${branch}?expand=1`,
    };
  }

  return { kind: 'browse', label: 'Open repository', href: browseUrl };
}

/**
 * Truncate a PR title to fit in the SessionInfoDialog row.
 * Appends an ellipsis when truncated.
 */
export function truncatePrTitle(title: string | null, max = 60): string {
  if (!title) return '';
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1).trimEnd()}…`;
}
