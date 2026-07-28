/**
 * Pure decision tree for the Agents session list body.
 *
 * Encapsulates the "what should the body show right now?" question so the
 * component only has to map the result onto the existing UI pieces
 * (`EmptyState`, `QueryError`, `SectionList`). Every input is a boolean
 * flag, the output is a small discriminated union — there is no React or
 * native dependency, so this module is unit-testable in plain Node.
 *
 * Classification rules (see Task 3 feature-state matrix):
 *  - The screen-level first-use empty ("No sessions yet" + New coding task)
 *    is handled by the caller BEFORE this function runs — it does not
 *    appear in the union. The model only decides what to render when
 *    there is at least some content (the screen-level "has any sessions"
 *    gate has already been passed, or the caller is asking what to put
 *    inside the SectionList body).
 *  - When the list body is empty (no history sections rendered):
 *      1. Active search/filter query → filtered-empty OR query-error
 *         (when in error). EXCEPTION: a text search with a populated
 *         tray returns render-list — tray matches are matches, so the
 *         body never claims "No sessions match" beneath them. The
 *         query-error variant always gets a Retry CTA; a secondary
 *         Clear CTA is shown for any active query ("Clear search" or
 *         "Clear filters"), while a no-query error shows only Retry.
 *      2. No query, error → retry-capable error empty state.
 *      3. No query, no error → compact "No past sessions" + New coding
 *         task CTA.
 *  - `showInlineError` mirrors the prior inline header ("Couldn't refresh.
 *    Pull down to try again.") and is ADDITIONALLY driven by the
 *    active-only failure flag (`activeIsError`) so the tray's non-blocking
 *    staleness surface is rendered whenever there is visible content.
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
      primaryAction: 'new-task';
      showInlineError: boolean;
    };

type SessionListBodyModelInputs = {
  /** True when rendered history sections contain at least one row. */
  hasHistoryContent: boolean;
  /**
   * True when the pinned "Active now" tray is non-empty. A populated tray
   * suppresses the full-screen QueryError (the screen-level first-use
   * gate already accounts for it) and contributes to the
   * "visible cached content" check that drives the inline error line.
   */
  hasPinnedActive: boolean;
  /** True when a search query OR a platform/project filter is active. */
  hasActiveQuery: boolean;
  /** True when the active search text is non-empty. */
  isSearching: boolean;
  /**
   * Body-driving error flag. The screen combines search and non-search
   * errors here, BUT active-only failures are NOT folded in — they
   * surface via `showInlineError` and never select the search-error
   * message.
   */
  isError: boolean;
  /**
   * Whether the active-poll query itself failed. Drives ONLY the inline
   * error line when content is visible; never selects a body empty state
   * or the search-error message.
   */
  activeIsError: boolean;
};

export function selectSessionListBodyModel(
  inputs: SessionListBodyModelInputs
): SessionListBodyModel {
  const {
    hasHistoryContent,
    hasPinnedActive,
    hasActiveQuery,
    isSearching,
    isError,
    activeIsError,
  } = inputs;

  const showInlineError = (isError || activeIsError) && (hasHistoryContent || hasPinnedActive);

  // History has rows — nothing to decide at the body level.
  if (hasHistoryContent) {
    return { kind: 'render-list', primaryAction: 'none', showInlineError };
  }

  // History empty: priority is the active query branch. A text search
  // with a populated tray renders the list instead (tray matches are
  // matches); filter-only narrowing keeps the filtered-empty body even
  // when the tray is populated (pre-existing decision).
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
    // Text search: matches in the tray are matches. Never claim "No sessions
    // match" beneath a populated tray — the tray is part of the searched
    // corpus. (Filter-only narrowing keeps the pre-existing behavior by
    // design — the tray was always part of that corpus's decision.)
    if (isSearching && hasPinnedActive) {
      return { kind: 'render-list', primaryAction: 'none', showInlineError };
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

  return {
    kind: 'no-past-sessions',
    primaryAction: 'new-task',
    showInlineError,
  };
}
