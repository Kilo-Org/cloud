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

/**
 * Truncate a PR title to fit in the SessionInfoDialog row.
 * Appends an ellipsis when truncated.
 */
export function truncatePrTitle(title: string | null, max = 60): string {
  if (!title) return '';
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1).trimEnd()}…`;
}
