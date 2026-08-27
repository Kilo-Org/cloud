import { describe, expect, it } from 'vitest';

import { selectSessionListBodyModel } from './session-list-body-model';

function model(overrides: Partial<Parameters<typeof selectSessionListBodyModel>[0]> = {}) {
  return selectSessionListBodyModel({
    hasHistoryContent: false,
    hasActiveQuery: false,
    isSearching: false,
    isError: false,
    ...overrides,
  });
}

describe('selectSessionListBodyModel', () => {
  describe('happy (history present)', () => {
    it('hides the inline error when nothing is in error and history is shown', () => {
      expect(model({ hasHistoryContent: true })).toEqual({
        kind: 'render-list',
        primaryAction: 'none',
        showInlineError: false,
      });
    });

    it('shows the inline error when history rows are rendered and the body errored', () => {
      expect(model({ hasHistoryContent: true, isError: true })).toEqual({
        kind: 'render-list',
        primaryAction: 'none',
        showInlineError: true,
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

    it('returns no-past-sessions with no CTA when the stored list is empty and no query is active', () => {
      expect(model({ hasHistoryContent: false })).toEqual({
        kind: 'no-past-sessions',
        primaryAction: 'none',
        showInlineError: false,
      });
    });
  });
});
