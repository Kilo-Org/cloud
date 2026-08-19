// Pure row-state selection for a recents entry. Extracted so the
// duplicated fallback line (title-less entries printing the identity
// twice) and the failed-entry marker are unit-tested.

import { type RecentPr } from '@/lib/pr-review/recent-prs';

export type RecentPrRowState = {
  /** Title when non-empty, else the identity line. */
  primary: string;
  /** The identity line, or null when it would repeat `primary`. */
  secondary: string | null;
  /** True when the entry's last load attempt failed. */
  failed: boolean;
};

export function selectRecentPrRowState(entry: RecentPr): RecentPrRowState {
  const identity = `${entry.owner}/${entry.repo}#${entry.number}`;
  const primary = entry.title.length > 0 ? entry.title : identity;
  return {
    primary,
    secondary: primary === identity ? null : identity,
    failed: entry.lastResult === 'failed',
  };
}
