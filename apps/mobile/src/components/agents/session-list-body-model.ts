/**
 * Pure decision tree for the Agents session list body.
 *
 * Encapsulates the "what should the body show right now?" question so the
 * component only has to map the result onto the existing UI pieces
 * (`EmptyState`, `QueryError`, `FlashList`). Every input is a boolean
 * flag, the output is a small discriminated union — there is no React or
 * native dependency, so this module is unit-testable in plain Node.
 *
 * Classification rules:
 *  - When the list body is empty (no history sections rendered):
 *      1. Active search/filter query → filtered-empty OR query-error
 *         (when in error). The query-error variant always gets a Retry CTA.
 *         Either variant carries one Clear action per active narrowing input
 *         ("Clear search", "Clear filters", or both), because each button
 *         clears only what its label names.
 *      2. No query, error → retry-capable error empty state.
 *      3. No query, no error → "No past sessions" with no CTA.
 *  - `showInlineError` mirrors the prior inline header ("Couldn't refresh.
 *    Pull down to try again.") and shows only when history rows are
 *    rendered and the body-driving error flag is set.
 */

/** One clear control; it retires exactly the input its label names. */
export type SessionListClearAction = 'clear-search' | 'clear-filters';

export type SessionListBodyModel =
  | {
      kind: 'render-list';
      showInlineError: boolean;
    }
  | {
      kind: 'filtered-empty';
      clearActions: SessionListClearAction[];
      showInlineError: boolean;
    }
  | {
      kind: 'query-error-empty';
      clearActions: SessionListClearAction[];
      showInlineError: boolean;
    }
  | {
      kind: 'no-past-sessions';
      showInlineError: boolean;
    };

type SessionListBodyModelInputs = {
  /** True when rendered history sections contain at least one row. */
  hasHistoryContent: boolean;
  /** True when the active search text is non-empty. */
  isSearching: boolean;
  /** True when a platform or project filter narrows the list. */
  hasActiveFilters: boolean;
  /** Body-driving error flag: a search failure (when searching) OR a
   * stored/history failure. */
  isError: boolean;
};

export function selectSessionListBodyModel(
  inputs: SessionListBodyModelInputs
): SessionListBodyModel {
  const { hasHistoryContent, isSearching, hasActiveFilters, isError } = inputs;

  // Inline error only widens when history rows are rendered; empty
  // search/filter states surface their own body-level error and never gain
  // a second inline line.
  const showInlineError = isError && hasHistoryContent;

  // History has rows — nothing to decide at the body level.
  if (hasHistoryContent) {
    return { kind: 'render-list', showInlineError };
  }

  // One action per narrowing input, search first: a search and a filter can
  // both hide the session, so the body must be able to retire each on its own.
  const clearActions: SessionListClearAction[] = [];
  if (isSearching) {
    clearActions.push('clear-search');
  }
  if (hasActiveFilters) {
    clearActions.push('clear-filters');
  }

  // History empty: priority is the active query branch.
  if (clearActions.length > 0) {
    if (isError) {
      return {
        kind: 'query-error-empty',
        clearActions,
        showInlineError,
      };
    }
    return {
      kind: 'filtered-empty',
      clearActions,
      showInlineError,
    };
  }

  // No active query, history empty.
  if (isError) {
    return {
      kind: 'query-error-empty',
      clearActions,
      showInlineError,
    };
  }

  // No past sessions: the body is empty and carries no CTA.
  return {
    kind: 'no-past-sessions',
    showInlineError,
  };
}
