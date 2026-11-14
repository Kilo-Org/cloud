import { describe, expect, it } from 'vitest';

import { selectSessionListBodyModel } from './session-list-body-model';

function model(overrides: Partial<Parameters<typeof selectSessionListBodyModel>[0]> = {}) {
  return selectSessionListBodyModel({
    hasHistoryContent: false,
    isSearching: false,
    hasActiveFilters: false,
    isError: false,
    ...overrides,
  });
}

describe('selectSessionListBodyModel', () => {
  describe('happy (history present)', () => {
    it('hides the inline error when nothing is in error and history is shown', () => {
      expect(model({ hasHistoryContent: true })).toEqual({
        kind: 'render-list',
        showInlineError: false,
      });
    });

    it('shows the inline error when history rows are rendered and the body errored', () => {
      expect(
        model({
          hasHistoryContent: true,
          isSearching: true,
          isError: true,
        })
      ).toEqual({
        kind: 'render-list',
        showInlineError: true,
      });
    });
  });

  describe('empty body with active query', () => {
    it('shows filtered-empty + Clear search when a search is active', () => {
      expect(
        model({
          isSearching: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        clearActions: ['clear-search'],
        showInlineError: false,
      });
    });

    it('shows filtered-empty + Clear filters when only a narrowing filter is active', () => {
      expect(
        model({
          hasActiveFilters: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        clearActions: ['clear-filters'],
        showInlineError: false,
      });
    });

    it('offers both clear actions when a search and a filter narrow the list', () => {
      expect(
        model({
          isSearching: true,
          hasActiveFilters: true,
        })
      ).toEqual({
        kind: 'filtered-empty',
        clearActions: ['clear-search', 'clear-filters'],
        showInlineError: false,
      });
    });

    it('shows query-error + Retry + Clear search for a search in error', () => {
      expect(
        model({
          isSearching: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        clearActions: ['clear-search'],
        showInlineError: false,
      });
    });

    it('shows query-error + Retry + Clear filters for a filter in error', () => {
      expect(
        model({
          hasActiveFilters: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        clearActions: ['clear-filters'],
        showInlineError: false,
      });
    });

    it('keeps both clear actions in the error body so neither cause is hidden', () => {
      expect(
        model({
          isSearching: true,
          hasActiveFilters: true,
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        clearActions: ['clear-search', 'clear-filters'],
        showInlineError: false,
      });
    });
  });

  describe('empty body without active query', () => {
    it('shows retryable error empty with Retry (no Clear) when the body errored', () => {
      expect(
        model({
          isError: true,
        })
      ).toEqual({
        kind: 'query-error-empty',
        clearActions: [],
        showInlineError: false,
      });
    });

    it('returns no-past-sessions with no CTA when the stored list is empty and no query is active', () => {
      expect(model()).toEqual({
        kind: 'no-past-sessions',
        showInlineError: false,
      });
    });
  });
});
