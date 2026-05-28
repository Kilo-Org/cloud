/**
 * Pure UI helpers for GitHub PR badges and associated PR data.
 */

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required';

export type AssociatedPr = {
  url: string;
  number: number;
  state: string;
  title: string | null;
  headSha: string | null;
  lastSyncedAt: string;
  reviewDecision: ReviewDecision | null;
  // Server is currently fetching the review decision for this PR. The list
  // hook polls while any row is pending so the badge updates without a manual
  // refresh.
  reviewDecisionPending: boolean;
};

export type PrBadgeState = 'open' | 'closed' | 'merged' | 'draft';

/**
 * Interpret the raw PR state string (as GitHub returns it + our "merged" /
 * "draft" flags from the backend) into one of four UI buckets.
 *
 * GitHub state is 'open' or 'closed'; closed-and-merged PRs are surfaced as
 * 'merged' and open-but-draft PRs as 'draft' by the backend refresh endpoint.
 */
export function normalizePrBadgeState(state: string): PrBadgeState {
  if (state === 'merged') return 'merged';
  if (state === 'draft') return 'draft';
  if (state === 'open') return 'open';
  return 'closed';
}

/**
 * Returns the CSS accent color for a PR badge, matching the Agent Manager
 * visual conventions in the kilocode repo.
 *
 * The returned string is a CSS `var(--color-*)` reference from the Tailwind 4
 * palette, suitable for use with `color-mix()` inline styles.
 */
export function prAccentColor(state: PrBadgeState, reviewDecision: ReviewDecision | null): string {
  if (state === 'merged') return 'var(--color-violet-400)';
  if (state === 'closed') return 'var(--color-red-400)';
  if (state === 'draft') return 'var(--color-zinc-400)';
  // Agent Manager uses amber for requested changes and emerald for other open PRs.
  if (reviewDecision === 'changes_requested') return 'var(--color-amber-400)';
  return 'var(--color-emerald-400)';
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
