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
  | 'offline'
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
  /**
   * No rows have arrived and no first-page failure was reported yet. This is
   * the query's pending status, not `isLoading`: a paused, offline or
   * cancelled first read is pending without fetching.
   */
  isPending: boolean;
  /** A first-page read is in flight right now. */
  isFetching: boolean;
  /**
   * The device's committed connectivity is offline. Only a paused first read
   * is affected: the online manager holds it, so it is pending without
   * fetching, and the connection — not the backend — owns that state.
   */
  isOffline?: boolean;
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
  const {
    isPending,
    isFetching,
    isOffline = false,
    itemCount,
    firstPageErrorState,
    laterPageError,
    organizationScopeAccess,
  } = args;

  if (organizationScopeAccess !== 'granted') {
    return {
      kind: organizationScopeAccess === 'denied' ? 'access-denied' : 'organization-unavailable',
      showLoadMoreRetry: false,
    };
  }

  // A failure is always its own state, whether or not a retry is in flight:
  // the view carries the reason and the Retry that recovers it.
  if (firstPageErrorState) {
    return { kind: firstPageErrorState.kind, showLoadMoreRetry: false };
  }

  // The skeleton is only honest while a read is actually in flight. A first
  // page that is pending without fetching — paused because the device reports
  // itself offline, cancelled, or never started — would otherwise keep the
  // skeleton up forever with nothing to press. It never settles on its own, so
  // it takes a failure body: nothing has loaded, nothing was reported empty,
  // and the user gets the Retry that restarts the read. A confirmed-offline
  // device names the connection; every other pause keeps the read's own copy,
  // because a cancelled or never-started read is not the network's fault.
  if (isPending) {
    let kind: PrInboxViewKind = 'retryable';
    if (isFetching) {
      kind = 'loading';
    } else if (isOffline) {
      kind = 'offline';
    }
    return { kind, showLoadMoreRetry: false };
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
