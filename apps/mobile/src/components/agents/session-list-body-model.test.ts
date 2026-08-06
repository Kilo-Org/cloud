// oxlint-disable max-lines -- one coherent decision-tree suite; every branch maps to a feature-state row in the model's doc comment
import { describe, expect, it } from 'vitest';

import { selectSessionListBodyModel } from './session-list-body-model';

function model(overrides: Partial<Parameters<typeof selectSessionListBodyModel>[0]> = {}) {
  return selectSessionListBodyModel({
    hasHistoryContent: false,
    hasStoredSessions: false,
    hasMoreHistory: false,
    hasPinnedActive: false,
    hasActiveQuery: false,
    isSearching: false,
    isError: false,
    activeIsError: false,
    ...overrides,
  });
}

describe('selectSessionListBodyModel', () => {
  describe('happy (history present)', () => {
    it('renders the list with no CTA and no inline error', () => {
      expect(
        model({
          hasHistoryContent: true,
          hasPinnedActive: true,
          activeIsError: true,
        })
      ).toEqual({ kind: 'render-list', primaryAction: 'none', showInlineError: true });
    });

    it('hides the inline error when nothing is in error and history is shown', () => {
      expect(model({ hasHistoryContent: true })).toEqual({
        kind: 'render-list',
        primaryAction: 'none',
        showInlineError: false,
      });
    });
  });

  describe('empty body with active query', () => {
    it('shows filtered-empty + Clear search when a search is active', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasActiveQuery: true,
          isSearching: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        primaryAction: 'clear-search',
        showInlineError: false,
      });
    });

    it('shows filtered-empty + Clear filters when only a narrowing filter is active', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasActiveQuery: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        primaryAction: 'clear-filters',
        showInlineError: false,
      });
    });

    it('shows query-error + Retry + Clear search for a search in error', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasActiveQuery: true,
          isSearching: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'clear-search',
        showInlineError: false,
      });
    });

    it('shows query-error + Retry + Clear filters for a filter in error', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasActiveQuery: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'clear-filters',
        showInlineError: false,
      });
    });

    it('a populated tray suppresses the filtered-empty body while searching', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
          hasActiveQuery: true,
          isSearching: true,
        })
      ).toEqual({
        kind: 'render-list',
        primaryAction: 'none',
        showInlineError: false,
      });
    });

    it('a populated tray does not change the filter-only body decision', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
          hasActiveQuery: true,
          isSearching: false,
        })
      ).toEqual({
        kind: 'filtered-empty',
        primaryAction: 'clear-filters',
        showInlineError: false,
      });
    });

    it('a populated tray does not change the query-error body decision while searching', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
          hasActiveQuery: true,
          isSearching: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'clear-search',
        showInlineError: true,
      });
    });
  });

  describe('stored rows do not widen inline errors into query states', () => {
    it('does not add an inline error to a stored-row search error with an empty tray', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasStoredSessions: true,
          hasActiveQuery: true,
          isSearching: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'clear-search',
        showInlineError: false,
      });
    });

    it('does not add an inline error to a stored-row filter error with an empty tray', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasStoredSessions: true,
          hasActiveQuery: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'clear-filters',
        showInlineError: false,
      });
    });

    it('does not add an inline error to a stored-row search with an active-poll failure and empty tray', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasStoredSessions: true,
          hasActiveQuery: true,
          isSearching: true,
          activeIsError: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        primaryAction: 'clear-search',
        showInlineError: false,
      });
    });

    it('does not add an inline error to a stored-row filter with an active-poll failure and empty tray', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasStoredSessions: true,
          hasActiveQuery: true,
          activeIsError: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        primaryAction: 'clear-filters',
        showInlineError: false,
      });
    });
  });

  describe('empty body without active query', () => {
    it('shows retryable error empty with Retry (no Clear) when the body errored', () => {
      expect(
        model({
          hasHistoryContent: false,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'none',
        showInlineError: false,
      });
    });

    it('shows the compact "No past sessions" empty with New coding task when no error and a tray is present', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
        })
      ).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'new-task',
        showInlineError: false,
      });
    });

    it('returns no-past-sessions even when the tray is empty (first-use is handled by the caller)', () => {
      expect(model({ hasHistoryContent: false })).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'new-task',
        showInlineError: false,
      });
    });
  });

  describe('all-pinned body (tray populated, stored rows fully excluded)', () => {
    it('returns all-active with no CTA when every stored row is active and history is exhausted', () => {
      expect(
        model({
          hasPinnedActive: true,
          hasStoredSessions: true,
        })
      ).toEqual({ kind: 'all-active', primaryAction: 'none', showInlineError: false });
    });

    it('keeps the list rendered while more history pages exist (backfill in flight or bound reached)', () => {
      expect(
        model({
          hasPinnedActive: true,
          hasStoredSessions: true,
          hasMoreHistory: true,
        })
      ).toEqual({ kind: 'render-list', primaryAction: 'none', showInlineError: false });
    });

    it('error takes precedence over all-active (Retry still wins)', () => {
      expect(
        model({
          hasPinnedActive: true,
          hasStoredSessions: true,
          hasMoreHistory: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'none',
        showInlineError: true,
      });
    });

    it('a populated tray with no stored rows stays no-past-sessions (CLI-only live sessions)', () => {
      expect(model({ hasPinnedActive: true, hasStoredSessions: false })).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'new-task',
        showInlineError: false,
      });
    });
  });

  describe('all-active while the tray is empty (full-view exclusion window)', () => {
    it('returns all-active with no CTA when stored rows load and every one is excluded before enrichment', () => {
      expect(
        model({
          hasStoredSessions: true,
        })
      ).toEqual({ kind: 'all-active', primaryAction: 'none', showInlineError: false });
    });

    it('keeps all-active while more history pages exist but the tray is empty (render-list keeps its tray conjunct)', () => {
      expect(
        model({
          hasStoredSessions: true,
          hasMoreHistory: true,
        })
      ).toEqual({ kind: 'all-active', primaryAction: 'none', showInlineError: false });
    });

    it('shows the inline error when the active poll failed during the all-excluded window', () => {
      expect(
        model({
          hasStoredSessions: true,
          activeIsError: true,
        })
      ).toEqual({ kind: 'all-active', primaryAction: 'none', showInlineError: true });
    });

    it('keeps query-error precedence when the stored query itself errored', () => {
      expect(
        model({
          hasStoredSessions: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        primaryAction: 'retry',
        secondaryAction: 'none',
        showInlineError: true,
      });
    });
  });

  describe('inline error / staleness surfacing', () => {
    it('shows the inline error when only the active poll failed and the tray is present', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
          activeIsError: true,
        })
      ).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'new-task',
        showInlineError: true,
      });
    });

    it('does not show the inline error when only the active poll failed and nothing is visible', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: false,
          activeIsError: true,
        })
      ).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'new-task',
        showInlineError: false,
      });
    });

    it('does NOT show the inline error when the body and tray are empty even if search+active errored', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasActiveQuery: true,
          isSearching: true,
          isError: true,
          activeIsError: true,
        }).showInlineError
      ).toBe(false);
    });

    it('does NOT collapse a simultaneous search+active failure into the search-error message (search surface still wins)', () => {
      const result = model({
        hasHistoryContent: false,
        hasActiveQuery: true,
        isSearching: true,
        isError: true,
        activeIsError: true,
      });
      expect(result.kind).toBe('query-error-empty');
      expect(result.primaryAction).toBe('retry');
      expect(result.showInlineError).toBe(false);
    });
  });
});
