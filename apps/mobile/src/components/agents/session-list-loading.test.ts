import { describe, expect, it } from 'vitest';

import { selectSessionListContentSurface } from './session-list-content-surface';
import { selectSessionListIsLoading } from './session-list-loading';

function loading(overrides: Partial<Parameters<typeof selectSessionListIsLoading>[0]> = {}) {
  return selectSessionListIsLoading({
    ready: true,
    isSearching: false,
    searchIsPending: false,
    storedIsPending: false,
    searchIsPaused: false,
    storedIsPaused: false,
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

    it('a paused search is unresolved, not loading', () => {
      // Offline with no cached search page: the read will not settle until the
      // network returns, so skeletons here would never land. The body shows the
      // offline state with a retry instead.
      expect(
        loading({
          isSearching: true,
          searchIsPending: true,
          searchIsPaused: true,
          storedIsPending: false,
        })
      ).toBe(false);
    });

    it('a paused stored read is unresolved, not loading', () => {
      expect(
        loading({
          isSearching: false,
          storedIsPending: true,
          storedIsPaused: true,
          searchIsPending: false,
        })
      ).toBe(false);
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
      isPaused: false,
      isError: false,
      isRetrying: false,
      hasAnySessions: false,
      hasHistoryContent: false,
      // No active query and no rows delivered by this mount: the branch's
      // extended surface input. Required by `selectSessionListContentSurface`
      // after the FlashList merge.
      hasActiveQuery: false,
      hasFreshHistory: false,
    };

    it('selects skeletons, never the history-empty surface, before the request settles', () => {
      const isLoading = loading({ isSearching: false, storedIsPending: true });
      expect(selectSessionListContentSurface({ isLoading, ...surfaceInput })).toEqual({
        // The FlashList branch renamed the body kind from `section-list` to
        // `session-list`; keep main's cold-open assertion against the new kind.
        kind: 'session-list',
        listEmpty: 'loading-skeletons',
      });
    });

    it('selects the history-empty surface only after the request settles', () => {
      const isLoading = loading({ isSearching: false, storedIsPending: false });
      expect(selectSessionListContentSurface({ isLoading, ...surfaceInput })).toEqual({
        kind: 'history-empty',
      });
    });

    it('selects the offline surface, never skeletons, for a paused search', () => {
      // Offline with no cached search page: the read is neither loading nor
      // errored and will not settle on its own, so the surface carries the
      // offline card with its own Retry.
      const isLoading = loading({
        isSearching: true,
        searchIsPending: true,
        searchIsPaused: true,
      });
      expect(
        selectSessionListContentSurface({ isLoading, ...surfaceInput, isPaused: true })
      ).toEqual({ kind: 'offline' });
    });

    it('selects the offline surface for a paused stored read', () => {
      const isLoading = loading({
        isSearching: false,
        storedIsPending: true,
        storedIsPaused: true,
      });
      expect(
        selectSessionListContentSurface({ isLoading, ...surfaceInput, isPaused: true })
      ).toEqual({ kind: 'offline' });
    });
  });
});
