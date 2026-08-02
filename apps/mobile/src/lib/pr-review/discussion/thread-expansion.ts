// Pure helpers for discussion-thread expand/collapse state.
//
// Expansion is owned by the Discussion tab (keyed by threadId) so FlashList
// recycling cannot leak open/closed state across rows, and so a single path
// can gate expand behind a short scroll settle when the tapped row is
// top-clipped (maintainVisibleContentPosition anchors on the first fully
// visible row and would otherwise jump the header off-screen).
//
// First-sight seeding preserves mount-time defaults: resolving a thread does
// NOT auto-collapse it (matches today's useState(!isResolved) behavior).

export function expandedForThread(
  state: Record<string, boolean>,
  threadId: string,
  isResolved: boolean
): boolean {
  return state[threadId] ?? !isResolved;
}

/**
 * Seed `!isResolved` for previously-unseen threadIds. Preserves every existing
 * entry. Returns the same reference when nothing is new.
 */
export function seedThreadExpansion(
  state: Record<string, boolean>,
  threads: readonly { readonly threadId: string; readonly isResolved: boolean }[]
): Record<string, boolean> {
  let next: Record<string, boolean> | null = null;
  for (const thread of threads) {
    if (!Object.hasOwn(state, thread.threadId)) {
      next ??= { ...state };
      next[thread.threadId] = !thread.isResolved;
    }
  }
  return next ?? state;
}

/** Flip the effective expanded value and store it explicitly. */
export function toggleThreadExpanded(
  state: Record<string, boolean>,
  threadId: string,
  isResolved: boolean
): Record<string, boolean> {
  const current = expandedForThread(state, threadId, isResolved);
  return { ...state, [threadId]: !current };
}

/** Force expand (deferred settle path). Same reference if already true. */
export function expandThread(
  state: Record<string, boolean>,
  threadId: string
): Record<string, boolean> {
  if (state[threadId] === true) {
    return state;
  }
  return { ...state, [threadId]: true };
}

/**
 * Whether expand must wait for a scroll settle before the row grows.
 *
 * | condition | result |
 * |---|---|
 * | null layout | defer (unknown geometry) |
 * | absoluteScrollOffset > rowTopContentOffset | defer (top-clipped) |
 * | otherwise | expand directly |
 */
export function shouldDeferExpand(
  rowTopContentOffset: number | null,
  absoluteScrollOffset: number
): boolean {
  if (rowTopContentOffset === null) {
    return true;
  }
  return absoluteScrollOffset > rowTopContentOffset;
}
