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
  | 'permission'
  | 'not-found'
  | 'reconnect';

export type PrInboxView = {
  kind: PrInboxViewKind;
  /** Show the inline "Couldn't load more" + Retry footer row. */
  showLoadMoreRetry: boolean;
};

export function selectPrInboxView(args: {
  isLoading: boolean;
  itemCount: number;
  firstPageErrorState: PrReviewQueryState | null;
  laterPageError: boolean;
}): PrInboxView {
  const { isLoading, itemCount, firstPageErrorState, laterPageError } = args;

  if (firstPageErrorState) {
    return { kind: firstPageErrorState.kind, showLoadMoreRetry: false };
  }

  if (isLoading) {
    return { kind: 'loading', showLoadMoreRetry: false };
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
