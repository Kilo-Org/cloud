import { describe, expect, it } from 'vitest';

import { selectSessionListContentSurface } from './session-list-content-surface';
import { selectSessionListIsLoading } from './session-list-loading';

function loading(overrides: Partial<Parameters<typeof selectSessionListIsLoading>[0]> = {}) {
  return selectSessionListIsLoading({
    ready: true,
    isSearching: false,
    searchIsPending: false,
    storedIsPending: false,
    ...overrides,
  });
}

describe('selectSessionListIsLoading', () => {
  describe('cold open — first render before the request settles', () => {
    it('treats the very first render as loading, not a settled empty list', () => {
      // React Query v5 reports isLoading/isFetching false until the observer
      // starts the fetch; only isPending is true. The surface must show
      // skeletons, never the empty state, on this frame.
      expect(loading({ isSearching: false, searchIsPending: false, storedIsPending: true })).toBe(
        true
      );
    });

    it('stays loading until the query inputs resolve', () => {
      expect(loading({ ready: false, isSearching: false, storedIsPending: true })).toBe(true);
      expect(loading({ ready: false, isSearching: false, storedIsPending: false })).toBe(true);
    });

    it('treats a pending search on the first render as loading', () => {
      expect(loading({ isSearching: true, searchIsPending: true, storedIsPending: false })).toBe(
        true
      );
    });
  });

  describe('after load', () => {
    it('is not loading once the stored query settles with no rows (true empty)', () => {
      expect(loading({ isSearching: false, searchIsPending: false, storedIsPending: false })).toBe(
        false
      );
    });

    it('keeps cached rows rendering during a background refetch', () => {
      // Whatever the fetch flags say, a cached page means no blanking: the
      // caller passes storedIsPending false as soon as any page is cached.
      expect(loading({ isSearching: false, searchIsPending: false, storedIsPending: false })).toBe(
        false
      );
    });

    it('stops loading when a search settles with no matches', () => {
      expect(loading({ isSearching: true, searchIsPending: false, storedIsPending: false })).toBe(
        false
      );
    });

    it('reads the search flag, not the stored flag, while searching', () => {
      expect(loading({ isSearching: true, searchIsPending: false, storedIsPending: true })).toBe(
        false
      );
      expect(loading({ isSearching: false, searchIsPending: true, storedIsPending: false })).toBe(
        false
      );
    });
  });

  // Ties the loading decision to the body-surface decision: the combination is
  // what the screen actually renders, and it is where the flash came from.
  describe('cold-open body-surface decision', () => {
    const surfaceInput = {
      isError: false,
      hasAnySessions: false,
      hasHistoryContent: false,
    };

    it('selects skeletons, never the history-empty surface, before the request settles', () => {
      const isLoading = loading({ isSearching: false, storedIsPending: true });
      expect(selectSessionListContentSurface({ isLoading, ...surfaceInput })).toEqual({
        kind: 'section-list',
        listEmpty: 'loading-skeletons',
      });
    });

    it('selects the history-empty surface only after the request settles', () => {
      const isLoading = loading({ isSearching: false, storedIsPending: false });
      expect(selectSessionListContentSurface({ isLoading, ...surfaceInput })).toEqual({
        kind: 'history-empty',
      });
    });
  });
});
