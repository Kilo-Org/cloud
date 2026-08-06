import { describe, expect, it } from 'vitest';

import {
  MAX_HISTORY_AUTOLOAD_PAGES,
  shouldBackfillHistoryAfterActiveExclusion,
} from './session-list-backfill';

function params(
  overrides: Partial<Parameters<typeof shouldBackfillHistoryAfterActiveExclusion>[0]> = {}
) {
  return {
    hasHistoryContent: false,
    hasStoredSessions: true,
    hasMoreHistory: true,
    isFetchingNextPage: false,
    isFetching: false,
    isSearching: false,
    isLoading: false,
    isError: false,
    loadedPageCount: 1,
    ...overrides,
  };
}

describe('shouldBackfillHistoryAfterActiveExclusion', () => {
  it('returns true when every gate is green and the page bound is not reached', () => {
    expect(shouldBackfillHistoryAfterActiveExclusion(params())).toBe(true);
  });

  it.each([
    ['history content is visible', { hasHistoryContent: true }],
    ['no stored rows are loaded', { hasStoredSessions: false }],
    ['no further history page exists', { hasMoreHistory: false }],
    ['the next page is already fetching', { isFetchingNextPage: true }],
    ['any stored fetch is in flight', { isFetching: true }],
    ['search mode is committed', { isSearching: true }],
    ['the list is still loading', { isLoading: true }],
    ['the body is in error', { isError: true }],
  ])('blocks backfill when %s', (_label, gate) => {
    expect(shouldBackfillHistoryAfterActiveExclusion(params(gate))).toBe(false);
  });

  it('blocks backfill at the loaded-page bound even when every other gate is green', () => {
    expect(
      shouldBackfillHistoryAfterActiveExclusion(
        params({ loadedPageCount: MAX_HISTORY_AUTOLOAD_PAGES })
      )
    ).toBe(false);
  });

  it('allows backfill on the final page below the bound', () => {
    expect(
      shouldBackfillHistoryAfterActiveExclusion(
        params({ loadedPageCount: MAX_HISTORY_AUTOLOAD_PAGES - 1 })
      )
    ).toBe(true);
  });

  it('treats an unknown hasMoreHistory as no more pages', () => {
    expect(shouldBackfillHistoryAfterActiveExclusion(params({ hasMoreHistory: undefined }))).toBe(
      false
    );
  });
});
