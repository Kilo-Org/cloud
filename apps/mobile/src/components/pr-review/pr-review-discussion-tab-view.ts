// Pure state selector for the PR Review Discussion tab.
//
// Extracts the tab's existing branch chain (unchanged in behaviour) so the
// seven outcomes can be unit-tested. The tab renders exactly what it rendered
// before; this module only owns the decision.

export type DiscussionTabView = {
  kind:
    | 'permission'
    | 'not-found'
    | 'reconnect'
    | 'retryable'
    | 'offline'
    | 'service-unavailable'
    | 'loading'
    | 'empty'
    | 'happy';
};

export function selectDiscussionTabView(args: {
  firstPageErrorState: {
    kind:
      | 'permission'
      | 'not-found'
      | 'reconnect'
      | 'retryable'
      | 'offline'
      | 'service-unavailable';
  } | null;
  isPending: boolean;
  /**
   * The pending first page is paused — offline, or a fetch that will never
   * start (spot check e7).
   */
  isPaused: boolean;
  /**
   * The device's committed connectivity is offline. A paused first page is the
   * connection's doing then, not a read that failed, so it takes the
   * connection's copy.
   */
  isOffline?: boolean;
  isEmpty: boolean;
}): DiscussionTabView {
  const { firstPageErrorState, isPending, isPaused, isOffline = false, isEmpty } = args;

  if (firstPageErrorState) {
    return { kind: firstPageErrorState.kind };
  }
  if (isPending) {
    // A paused page has no end: the skeleton would sit there with no
    // comments, no empty state, and no error. Surface a failure state so the
    // tab always carries an escape — the connection's own when the device is
    // confirmed offline, the read's otherwise. A page in flight — and the one
    // frame before the fetch starts — keeps the skeleton.
    if (!isPaused) {
      return { kind: 'loading' };
    }
    return { kind: isOffline ? 'offline' : 'retryable' };
  }
  if (isEmpty) {
    return { kind: 'empty' };
  }
  return { kind: 'happy' };
}
