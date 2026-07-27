// Pure decision logic for resilient navigator scroll-to-file requests.
// When the target list key is momentarily absent from `indexByKey`
// (query-data → items rebuild race), keep the request pending and retry
// on the next items change. A newer request supersedes any pending one;
// unmount cancels.

/** Target list-item key waiting to become scrollable, or null. */
export type PendingScrollState = string | null;

type ScrollRequestDecision = {
  readonly pending: PendingScrollState;
  /** Present when the target key is in the map and scrolling should run now. */
  readonly index: number | null;
};

/**
 * Handle a new navigator scroll request. Supersedes any prior pending key.
 * Scrolls immediately when the key is already present; otherwise parks it.
 */
export function decideOnScrollRequest(
  _currentPending: PendingScrollState,
  targetKey: string,
  indexByKey: ReadonlyMap<string, number>
): ScrollRequestDecision {
  const index = indexByKey.get(targetKey);
  if (typeof index === 'number') {
    return { pending: null, index };
  }
  return { pending: targetKey, index: null };
}

/**
 * Re-check a pending request after `indexByKey` changes (items rebuild).
 * Resolves to a scroll index when the key appears; otherwise keeps waiting.
 */
export function decideOnItemsChange(
  pending: PendingScrollState,
  indexByKey: ReadonlyMap<string, number>
): ScrollRequestDecision {
  if (pending === null) {
    return { pending: null, index: null };
  }
  const index = indexByKey.get(pending);
  if (typeof index === 'number') {
    return { pending: null, index };
  }
  return { pending, index: null };
}

/** Clear any pending request (component unmount). */
export function cancelPendingScroll(): PendingScrollState {
  return null;
}
