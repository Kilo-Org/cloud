/**
 * Pure surface decision for the session-list body after the tray moved into
 * the SectionList header. Encodes the single-render-site contract:
 *  - Never early-return on loading — keep one SectionList mounted so the
 *    tray's local expanded state survives skeleton → rows.
 *  - Full-screen error / first-use empty only after loading completes.
 *  - Cold active-only failure gets its own full-screen retry surface once
 *    loading completes, instead of being misreported as first-use empty.
 *  - ListEmptyComponent prefers skeletons while loading over any body-empty
 *    kind (avoids flashing "No past sessions" / "No sessions yet" mid-load).
 */
type SessionListContentSurface =
  | { kind: 'full-screen-error' }
  | { kind: 'active-error-empty' }
  | { kind: 'first-use-empty' }
  | { kind: 'section-list'; listEmpty: 'loading-skeletons' | 'body-empty' | 'none' };

export function selectSessionListContentSurface(input: {
  isLoading: boolean;
  isError: boolean;
  activeIsError: boolean;
  hasAnySessions: boolean;
  hasPinnedActive: boolean;
  hasHistoryContent: boolean;
}): SessionListContentSurface {
  const { isLoading, isError, activeIsError, hasAnySessions, hasPinnedActive, hasHistoryContent } =
    input;

  // Gate non-list surfaces on !isLoading so a cold open (empty cache for the
  // whole load) cannot flash first-use empty or full-screen error.
  if (!isLoading && isError && !hasAnySessions && !hasPinnedActive) {
    return { kind: 'full-screen-error' };
  }
  // Cold active-only failure: the stored query succeeded empty but the active
  // poll failed before any data loaded. Retryable, so never claim "No
  // sessions yet". Stored-query errors above stay first.
  if (!isLoading && !hasAnySessions && activeIsError) {
    return { kind: 'active-error-empty' };
  }
  if (!isLoading && !hasAnySessions) {
    return { kind: 'first-use-empty' };
  }

  if (isLoading) {
    return { kind: 'section-list', listEmpty: 'loading-skeletons' };
  }
  if (!hasHistoryContent) {
    return { kind: 'section-list', listEmpty: 'body-empty' };
  }
  return { kind: 'section-list', listEmpty: 'none' };
}
