import { describe, expect, it } from 'vitest';

import { selectSessionListBodyModel } from './session-list-body-model';

function model(overrides: Partial<Parameters<typeof selectSessionListBodyModel>[0]> = {}) {
  return selectSessionListBodyModel({
    hasHistoryContent: false,
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

    it('a populated tray does not change the active-query body decision', () => {
      expect(
        model({
          hasHistoryContent: false,
          hasPinnedActive: true,
          hasActiveQuery: true,
          isSearching: true,
        }).kind
      ).toBe('filtered-empty');
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
