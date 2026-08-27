/**
 * Pure surface decision for the session-list body. Encodes the
 * single-render-site contract:
 *  - Never early-return on loading — keep one SectionList mounted so the
 *    tray's local expanded state survives skeleton → rows.
 *  - Full-screen error / history empty only after loading completes.
 *  - ListEmptyComponent prefers skeletons while loading over any body-empty
 *    kind (avoids flashing "No past sessions" mid-load).
 */
type SessionListContentSurface =
  | { kind: 'full-screen-error' }
  | { kind: 'history-empty' }
  | { kind: 'section-list'; listEmpty: 'loading-skeletons' | 'body-empty' | 'none' };

export function selectSessionListContentSurface(input: {
  isLoading: boolean;
  isError: boolean;
  hasAnySessions: boolean;
  hasHistoryContent: boolean;
}): SessionListContentSurface {
  const { isLoading, isError, hasAnySessions, hasHistoryContent } = input;

  // Gate non-list surfaces on !isLoading so a cold open (empty cache for the
  // whole load) cannot flash history-empty or full-screen error.
  if (!isLoading && isError && !hasAnySessions) {
    return { kind: 'full-screen-error' };
  }
  // No stored rows and no active query: render the history-empty body (the
  // screen gates its search chrome on `hasAnySessions` and renders this
  // full-screen).
  if (!isLoading && !hasAnySessions) {
    return { kind: 'history-empty' };
  }

  if (isLoading) {
    return { kind: 'section-list', listEmpty: 'loading-skeletons' };
  }
  if (!hasHistoryContent) {
    return { kind: 'section-list', listEmpty: 'body-empty' };
  }
  return { kind: 'section-list', listEmpty: 'none' };
}
