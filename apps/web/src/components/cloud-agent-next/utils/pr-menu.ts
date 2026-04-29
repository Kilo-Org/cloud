import type { AssociatedPullRequest } from '@/lib/cloud-agent-sdk';
import { buildRepoBrowseUrl, detectGitPlatform } from './git-utils';

export type PrMenuAction = {
  label: string;
  href: string;
  kind: 'pr' | 'compare' | 'browse';
};

/**
 * Decide what the "Open in GitHub" menu entry should look like given the
 * session's git URL, branch, and any PR we already have on file.
 *
 * - When an associated PR exists -> "Open PR #<n>" linking to the PR.
 * - When we have a GitHub branch but no PR -> "Open compare on GitHub"
 *   linking to the /compare/<branch>?expand=1 URL.
 * - Non-GitHub URL or missing branch -> fall back to repo browse URL.
 * - Nothing browseable -> returns null (caller should hide the entry).
 */
export function resolveGitHubMenuAction(input: {
  gitUrl: string | null | undefined;
  branch: string | null | undefined;
  associatedPr: AssociatedPullRequest | null | undefined;
}): PrMenuAction | null {
  const { gitUrl, branch, associatedPr } = input;

  if (associatedPr) {
    return {
      label: `Open PR #${associatedPr.number}`,
      href: associatedPr.url,
      kind: 'pr',
    };
  }

  const browseUrl = buildRepoBrowseUrl(gitUrl);
  if (!browseUrl) return null;

  if (branch && detectGitPlatform(gitUrl) === 'github') {
    return {
      label: 'Open compare on GitHub',
      href: `${browseUrl}/compare/${branch}?expand=1`,
      kind: 'compare',
    };
  }

  return {
    label: 'Open repository',
    href: browseUrl,
    kind: 'browse',
  };
}

export type PrStateVisual = {
  /** Short lowercase label, e.g. "open", "merged", "closed". */
  label: string;
  /** Tailwind classes for a small chip (same idiom as SessionsList badges). */
  chipClassName: string;
  /** Tailwind classes for a filled dot (for sidebar indicators). */
  dotClassName: string;
};

/**
 * Map a PR state string to a small set of visual styles.
 *
 * GitHub's API reports `state: 'open' | 'closed'` plus a separate `merged`
 * flag; our stored shape flattens that into `'open' | 'closed' | 'merged'`.
 * Unknown values fall back to the closed/gray treatment.
 */
export function prStateVisual(state: string): PrStateVisual {
  const normalized = state.toLowerCase();
  if (normalized === 'open') {
    return {
      label: 'open',
      chipClassName: 'bg-green-500/20 text-green-400',
      dotClassName: 'bg-green-500',
    };
  }
  if (normalized === 'merged') {
    return {
      label: 'merged',
      chipClassName: 'bg-purple-500/20 text-purple-400',
      dotClassName: 'bg-purple-500',
    };
  }
  return {
    label: normalized === 'closed' ? 'closed' : normalized,
    chipClassName: 'bg-muted text-muted-foreground',
    dotClassName: 'bg-gray-500',
  };
}
