import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';

/**
 * Splits the queued pending-review comments by whether each was written
 * against the PR's current head. `fresh` items submit; `stale` items stay
 * queued so the user can edit or delete them. An empty `headSha` (the
 * overview has not loaded yet) makes every item fresh — do not invent
 * staleness before the head is known.
 */
export type PendingItemPartition = {
  fresh: PendingReviewItem[];
  stale: PendingReviewItem[];
};

export function partitionPendingItems(
  items: readonly PendingReviewItem[],
  headSha: string
): PendingItemPartition {
  if (headSha === '') {
    return { fresh: [...items], stale: [] };
  }
  const fresh: PendingReviewItem[] = [];
  const stale: PendingReviewItem[] = [];
  for (const item of items) {
    if (item.commitSha === headSha) {
      fresh.push(item);
    } else {
      stale.push(item);
    }
  }
  return { fresh, stale };
}
