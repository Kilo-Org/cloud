/**
 * Pure decision tree for the Agents session list body.
 *
 * Encapsulates the "what should the body show right now?" question so the
 * component only has to map the result onto the existing UI pieces
 * (`EmptyState`, `QueryError`, `SectionList`). Every input is a boolean
 * flag, the output is a small discriminated union — there is no React or
 * native dependency, so this module is unit-testable in plain Node.
 *
 * Classification rules:
 *  - When the list body is empty (no history sections rendered):
 *      1. Active search/filter query → filtered-empty OR query-error
 *         (when in error). The query-error variant always gets a Retry CTA;
 *         a secondary Clear CTA is shown for any active query ("Clear
 *         search" or "Clear filters"), while a no-query error shows only
 *         Retry.
 *      2. No query, error → retry-capable error empty state.
 *      3. No query, no error → "No past sessions" with no CTA.
 *  - `showInlineError` mirrors the prior inline header ("Couldn't refresh.
 *    Pull down to try again.") and shows only when history rows are
 *    rendered and the body-driving error flag is set.
 */

export type SessionListBodyModel =
  | {
      kind: 'render-list';
      primaryAction: 'none';
      showInlineError: boolean;
    }
  | {
      kind: 'filtered-empty';
      primaryAction: 'clear-search' | 'clear-filters';
      showInlineError: boolean;
    }
  | {
      kind: 'query-error-empty';
      primaryAction: 'retry';
      secondaryAction: 'clear-search' | 'clear-filters' | 'none';
      showInlineError: boolean;
    }
  | {
      kind: 'no-past-sessions';
      primaryAction: 'none';
      showInlineError: boolean;
    };

type SessionListBodyModelInputs = {
  /** True when rendered history sections contain at least one row. */
  hasHistoryContent: boolean;
  /** True when a search query OR a platform/project filter is active. */
  hasActiveQuery: boolean;
  /** True when the active search text is non-empty. */
  isSearching: boolean;
  /** Body-driving error flag: a search failure (when searching) OR a
   * stored/history failure. */
  isError: boolean;
};

export function selectSessionListBodyModel(
  inputs: SessionListBodyModelInputs
): SessionListBodyModel {
  const { hasHistoryContent, hasActiveQuery, isSearching, isError } = inputs;

  // Inline error only widens when history rows are rendered; empty
  // search/filter states surface their own body-level error and never gain
  // a second inline line.
  const showInlineError = isError && hasHistoryContent;

  // History has rows — nothing to decide at the body level.
  if (hasHistoryContent) {
    return { kind: 'render-list', primaryAction: 'none', showInlineError };
  }

  // History empty: priority is the active query branch.
  if (hasActiveQuery) {
    if (isError) {
      // Query-error empty: Retry is always available. A Clear CTA is also
      // shown whenever an active query exists, choosing the label that
      // matches the active query type (search vs. narrowing filter).
      return {
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: isSearching ? 'clear-search' : 'clear-filters',
        showInlineError,
      };
    }
    return {
      kind: 'filtered-empty',
      primaryAction: isSearching ? 'clear-search' : 'clear-filters',
      showInlineError,
    };
  }

  // No active query, history empty.
  if (isError) {
    return {
      kind: 'query-error-empty',
      primaryAction: 'retry',
      secondaryAction: 'none',
      showInlineError,
    };
  }

  // No past sessions: the body is empty and carries no CTA.
  return {
    kind: 'no-past-sessions',
    primaryAction: 'none',
    showInlineError,
  };
}
