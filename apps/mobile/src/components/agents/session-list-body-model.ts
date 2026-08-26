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
 *         (when in error). A text search with a populated tray returns
 *         render-list — tray matches are matches. The query-error variant
 *         always gets a Retry CTA; a secondary Clear CTA is shown for any
 *         active query ("Clear search" or "Clear filters"), while a
 *         no-query error shows only Retry.
 *      2. No query, error → retry-capable error empty state.
 *      3. No query, no error → "No past sessions" with no CTA. Creation is
 *         offered by the FAB/tray on the live screen, so the body itself
 *         carries no create action.
 *  - `showInlineError` mirrors the prior inline header ("Couldn't refresh.
 *    Pull down to try again.") and is additionally driven by the
 *    active-only failure flag (`activeIsError`) so the tray's non-blocking
 *    staleness surface is rendered whenever there is visible content —
 *    history rows or a populated tray.
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
  /**
   * True when the pinned "Active now" tray is non-empty. A populated tray
   * suppresses the full-screen QueryError (the screen-level gate already
   * accounts for it) and contributes to the "visible cached content" check
   * that drives the inline error line.
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
  /** Accepted for the history screen's call-site compatibility; unused after
   * the combined-list removal. */
  hasStoredSessions?: boolean;
  /** Accepted for the history screen's call-site compatibility; unused after
   * the bounded backfill removal. */
  hasMoreHistory?: boolean;
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

  // Inline error only widens when there is visible content (history rows or
  // a populated tray); empty search/filter states surface their own
  // body-level error and never gain a second inline line.
  const showInlineError = (isError || activeIsError) && (hasHistoryContent || hasPinnedActive);

  // History has rows — nothing to decide at the body level.
  if (hasHistoryContent) {
    return { kind: 'render-list', primaryAction: 'none', showInlineError };
  }

  // History empty: priority is the active query branch. A text search
  // with a populated tray renders the list instead (tray matches are
  // matches); filter-only narrowing keeps the filtered-empty body even
  // when the tray is populated.
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
    // corpus.
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

  // No past sessions: the body is empty but the screen offers creation via
  // the FAB/tray, so the body itself carries no CTA.
  return {
    kind: 'no-past-sessions',
    primaryAction: 'none',
    showInlineError,
  };
}
