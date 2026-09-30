import { describe, expect, it } from 'vitest';

import { selectSessionListContentSurface } from './session-list-content-surface';
import { selectSessionListIsLoading } from './session-list-loading';

function loading(overrides: Partial<Parameters<typeof selectSessionListIsLoading>[0]> = {}) {
  return selectSessionListIsLoading({
    ready: true,
    isSearching: false,
    searchIsPending: false,
    storedIsPending: false,
    isPaused: false,
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

    it('settles a paused stored cold open instead of spinning skeletons forever', () => {
      // React Query pauses an offline query; `isPending` stays true for the
      // whole pause. The screen must stop loading so the error + retry shows.
      expect(loading({ storedIsPending: true, isPaused: true })).toBe(false);
    });

    it('settles a paused search cold open instead of spinning skeletons forever', () => {
      expect(
        loading({ isSearching: true, searchIsPending: true, isPaused: true, storedIsPending: true })
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
      isError: false,
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

    it('selects the retryable error surface for a paused offline cold open', () => {
      // The paused query is the body-driving error (see
      // use-agent-session-list-data), so the surface settles on the
      // full-screen error with its Retry instead of skeletons.
      const isLoading = loading({ storedIsPending: true, isPaused: true });
      expect(
        selectSessionListContentSurface({ isLoading, ...surfaceInput, isError: true })
      ).toEqual({ kind: 'full-screen-error' });
    });
  });
});
