import { describe, expect, it } from 'vitest';

import { selectSessionListContentSurface } from './session-list-content-surface';

function surface(overrides: Partial<Parameters<typeof selectSessionListContentSurface>[0]> = {}) {
  return selectSessionListContentSurface({
    isLoading: false,
    isError: false,
    hasAnySessions: true,
    hasPinnedActive: false,
    hasHistoryContent: true,
    ...overrides,
  });
}

describe('selectSessionListContentSurface', () => {
  describe('loading (single SectionList site)', () => {
    it('keeps the section-list path with skeleton empty while loading, even with empty cache', () => {
      // Cold open: hasAnySessions is false for the whole load. Must NOT fall
      // through to first-use empty — that would flash "No sessions yet".
      expect(
        surface({
          isLoading: true,
          hasAnySessions: false,
          hasPinnedActive: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'loading-skeletons' });
    });

    it('shows skeletons under a populated tray while history is still loading', () => {
      // Active query resolved first: tray visible via ListHeaderComponent,
      // history still loading → skeletons, NOT "No past sessions".
      expect(
        surface({
          isLoading: true,
          hasAnySessions: true,
          hasPinnedActive: true,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'loading-skeletons' });
    });

    it('does not surface full-screen error while still loading', () => {
      expect(
        surface({
          isLoading: true,
          isError: true,
          hasAnySessions: false,
          hasPinnedActive: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'loading-skeletons' });
    });
  });

  describe('after load — non-list surfaces', () => {
    it('shows full-screen error only when load finished with nothing on screen', () => {
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: false,
          hasPinnedActive: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'full-screen-error' });
    });

    it('suppresses full-screen error when the tray alone is on screen', () => {
      // Populated tray counts as content; body empty goes into the list.
      expect(
        surface({
          isLoading: false,
          isError: true,
          hasAnySessions: true,
          hasPinnedActive: true,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'body-empty' });
    });

    it('shows first-use empty only after load with no sessions at all', () => {
      expect(
        surface({
          isLoading: false,
          hasAnySessions: false,
          hasPinnedActive: false,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'first-use-empty' });
    });
  });

  describe('after load — section list', () => {
    it('renders history rows with no ListEmptyComponent when sections exist', () => {
      expect(
        surface({
          isLoading: false,
          hasAnySessions: true,
          hasHistoryContent: true,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'none' });
    });

    it('uses body-empty ListEmptyComponent when history is empty but sessions exist', () => {
      // Tray-only (or filtered empty) — body model decides the empty kind.
      expect(
        surface({
          isLoading: false,
          hasAnySessions: true,
          hasPinnedActive: true,
          hasHistoryContent: false,
        })
      ).toEqual({ kind: 'section-list', listEmpty: 'body-empty' });
    });
  });

  describe('ListEmptyComponent precedence', () => {
    it('prefers loading-skeletons over body-empty whenever isLoading', () => {
      // Explicit precedence: isLoading ? skeletons : body-empty.
      // hasHistoryContent false would otherwise be body-empty.
      const loading = surface({
        isLoading: true,
        hasAnySessions: true,
        hasPinnedActive: true,
        hasHistoryContent: false,
      });
      const loaded = surface({
        isLoading: false,
        hasAnySessions: true,
        hasPinnedActive: true,
        hasHistoryContent: false,
      });
      expect(loading).toEqual({ kind: 'section-list', listEmpty: 'loading-skeletons' });
      expect(loaded).toEqual({ kind: 'section-list', listEmpty: 'body-empty' });
    });
  });
});
