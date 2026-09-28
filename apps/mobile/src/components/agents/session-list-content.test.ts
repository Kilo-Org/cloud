import { describe, expect, it } from 'vitest';

import { selectSessionListContentSurface } from './session-list-content-surface';

function surface(overrides: Partial<Parameters<typeof selectSessionListContentSurface>[0]> = {}) {
  return selectSessionListContentSurface({
    isLoading: false,
    isError: false,
    hasAnySessions: true,
    hasHistoryContent: true,
    hasActiveQuery: false,
    hasFreshHistory: true,
    ...overrides,
  });
}

describe('selectSessionListContentSurface', () => {
  describe('loading (single list site)', () => {
    it('keeps the session-list path with skeleton empty while loading, even with empty cache', () => {
      // Cold open: hasAnySessions is false for the whole load. Must NOT fall
      // through to history-empty — that would flash "No past sessions".
      expect(
        surface({
          isLoading: true,
          hasAnySessions: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'loading-skeletons' });
    });

    it('does not surface full-screen error while still loading', () => {
      expect(
        surface({
          isLoading: true,
          isError: true,
          hasAnySessions: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'loading-skeletons' });
    });
  });

  describe('after load — non-list surfaces', () => {
    it('shows full-screen error only when load finished with nothing on screen', () => {
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'full-screen-error' });
    });

    it('shows full-screen error when a failed fresh open only has stale cached rows', () => {
      // Rows cached by an earlier mount are not a fallback for this screen's
      // own failed load — the user gets the retryable error, not stale rows.
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: true,
          hasHistoryContent: true,
          hasFreshHistory: false,
        })
      ).toEqual({ kind: 'full-screen-error' });
    });

    it('keeps rows delivered this mount when a later stored load fails', () => {
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: true,
          hasHistoryContent: true,
          hasFreshHistory: true,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'none' });
    });

    it('leaves the query error body to the active search/filter branch', () => {
      // A search/filter owns its own error body (Retry + Clear); stale stored
      // rows must not force the generic full-screen error over it.
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: true,
          hasHistoryContent: false,
          hasActiveQuery: true,
          hasFreshHistory: false,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'body-empty' });
    });

    it('does not flash the full-screen error while a stale open is still loading', () => {
      expect(
        surface({
          isLoading: true,
          isError: true,
          hasAnySessions: true,
          hasHistoryContent: false,
          hasFreshHistory: false,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'loading-skeletons' });
    });

    it('shows history-empty only after load with no sessions at all', () => {
      expect(
        surface({
          isLoading: false,
          hasAnySessions: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'history-empty' });
    });
  });

  describe('after load — session list', () => {
    it('renders history rows with no ListEmptyComponent when sections exist', () => {
      expect(
        surface({
          isLoading: false,
          hasAnySessions: true,
          hasHistoryContent: true,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'none' });
    });

    it('uses body-empty ListEmptyComponent when history is empty but sessions exist', () => {
      // Filtered empty — body model decides the empty kind.
      expect(
        surface({
          isLoading: false,
          hasAnySessions: true,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'session-list', listEmpty: 'body-empty' });
    });
  });

  describe('ListEmptyComponent precedence', () => {
    it('prefers loading-skeletons over body-empty whenever isLoading', () => {
      // Explicit precedence: isLoading ? skeletons : body-empty.
      // hasHistoryContent false would otherwise be body-empty.
      const loading = surface({
        isLoading: true,
        hasAnySessions: true,
        hasHistoryContent: false,
      });
      const loaded = surface({
        isLoading: false,
        hasAnySessions: true,
        hasHistoryContent: false,
      });
      expect(loading).toEqual({ kind: 'session-list', listEmpty: 'loading-skeletons' });
      expect(loaded).toEqual({ kind: 'session-list', listEmpty: 'body-empty' });
    });
  });
});
