// Pure state selection for the PR inbox list. Kept out of JSX so every
// branch is unit-tested. The inbox has the same four-state matrix as the
// rest of the PR Review surface, plus a later-page failure that keeps
// already-loaded rows and offers an inline retry.

import { type classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';

type PrReviewQueryState = ReturnType<typeof classifyPrReviewQueryState>;

type PrInboxViewKind =
  | 'loading'
  | 'happy'
  | 'empty'
  | 'retryable'
  | 'service-unavailable'
  | 'permission'
  | 'not-found'
  | 'reconnect';

export type PrInboxView = {
  kind: PrInboxViewKind;
  /** Show the inline "Couldn't load more" + Retry footer row. */
  showLoadMoreRetry: boolean;
};

export function selectPrInboxView(args: {
  /**
   * No rows have arrived and no first-page failure was reported yet. This is
   * the query's pending status, not `isLoading`: a paused, offline or
   * cancelled first read is pending without fetching.
   */
  isPending: boolean;
  /** A first-page read is in flight right now. */
  isFetching: boolean;
  itemCount: number;
  firstPageErrorState: PrReviewQueryState | null;
  laterPageError: boolean;
}): PrInboxView {
  const { isPending, isFetching, itemCount, firstPageErrorState, laterPageError } = args;

  // A failure is always its own state, whether or not a retry is in flight:
  // the view carries the reason and the Retry that recovers it.
  if (firstPageErrorState) {
    return { kind: firstPageErrorState.kind, showLoadMoreRetry: false };
  }

  // The skeleton is only honest while a read is actually in flight. A first
  // page that is pending without fetching — paused because the device reports
  // itself offline, cancelled, or never started — would otherwise keep the
  // skeleton up forever with nothing to press; it settles on the empty state
  // instead, which the user can retry from.
  if (isPending) {
    return { kind: isFetching ? 'loading' : 'empty', showLoadMoreRetry: false };
  }

  if (itemCount === 0) {
    // Nothing to show and at least one provider failed: the empty state would
    // claim "no review requests" while a connected provider is down, so the
    // retryable failure owns the surface and carries the retry that recovers
    // it. Empty stays reserved for "no rows and no failure".
    return laterPageError
      ? { kind: 'retryable', showLoadMoreRetry: false }
      : { kind: 'empty', showLoadMoreRetry: false };
  }

  return { kind: 'happy', showLoadMoreRetry: laterPageError };
}
