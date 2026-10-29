// Pure state selection for the PR inbox list. Kept out of JSX so every
// branch is unit-tested. The inbox has the same four-state matrix as the
// rest of the PR Review surface, plus a later-page failure that keeps
// already-loaded rows and offers an inline retry.

import { type PrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import { type OrganizationScopeAccess } from '@/lib/organization-scope-access';

type PrInboxViewKind =
  | 'loading'
  | 'happy'
  | 'empty'
  | 'retryable'
  | 'service-unavailable'
  | 'permission'
  | 'not-found'
  | 'reconnect'
  | 'access-denied'
  | 'organization-unavailable';

export type PrInboxView = {
  kind: PrInboxViewKind;
  /** Show the inline "Couldn't load more" + Retry footer row. */
  showLoadMoreRetry: boolean;
};

/**
 * The two views that mean the selected organization itself is refused, not a
 * provider within it. Both own the whole inbox body and offer the same way out,
 * so a caller that draws provider-recovery chrome must ask this instead of
 * listing the kinds itself.
 */
export function isOrganizationAccessView(view: PrInboxView): boolean {
  return view.kind === 'access-denied' || view.kind === 'organization-unavailable';
}

export function selectPrInboxView(args: {
  isLoading: boolean;
  itemCount: number;
  firstPageErrorState: PrReviewQueryState | null;
  laterPageError: boolean;
  /**
   * The selected organization's own access, from the scope's query denials.
   * A lost organization outranks every provider state: it denies the reads
   * those states describe, so rendering them would either claim nothing is
   * connected or offer a retry that can never succeed. Rows are dropped with
   * it — they were read under a scope the server no longer serves.
   */
  organizationScopeAccess: OrganizationScopeAccess;
}): PrInboxView {
  const { isLoading, itemCount, firstPageErrorState, laterPageError, organizationScopeAccess } =
    args;

  if (organizationScopeAccess !== 'granted') {
    return {
      kind: organizationScopeAccess === 'denied' ? 'access-denied' : 'organization-unavailable',
      showLoadMoreRetry: false,
    };
  }

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
