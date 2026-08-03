import { describe, expect, it } from 'vitest';

import { selectSessionListBodyModel, type SessionListBodyModel } from './session-list-body-model';
import { selectSessionListContentSurface } from './session-list-content-surface';

/**
 * Models the component's composition rule used in
 * `session-list-content.tsx:301-332`. Copied verbatim so the test
 * locks what the screen actually renders, not only the selectors.
 */
function renderedBody(
  surface: ReturnType<typeof selectSessionListContentSurface>,
  body: SessionListBodyModel
): string {
  if (surface.kind !== 'section-list') {
    /* full-screen-error | first-use-empty */
    return surface.kind;
  }
  if (surface.listEmpty === 'loading-skeletons') {
    return 'loading-skeletons';
  }
  if (surface.listEmpty === 'body-empty' && body.kind !== 'render-list') {
    return `body-empty:${body.kind}`;
  }
  /* ListEmptyComponent stays null */
  return 'nothing';
}

type CaseInputs = {
  isLoading: boolean;
  isError: boolean;
  hasAnySessions: boolean;
  hasPinnedActive: boolean;
  hasHistoryContent: boolean;
  hasActiveQuery: boolean;
  isSearching: boolean;
  activeIsError: boolean;
};

/** Produce the full cartesian product of 8 booleans — 256 cases. */
function allCases(): CaseInputs[] {
  return Array.from({ length: 256 }, (_, i) => ({
    isLoading: i % 2 === 1,
    isError: Math.floor(i / 2) % 2 === 1,
    hasAnySessions: Math.floor(i / 4) % 2 === 1,
    hasPinnedActive: Math.floor(i / 8) % 2 === 1,
    hasHistoryContent: Math.floor(i / 16) % 2 === 1,
    hasActiveQuery: Math.floor(i / 32) % 2 === 1,
    isSearching: Math.floor(i / 64) % 2 === 1,
    activeIsError: Math.floor(i / 128) % 2 === 1,
  }));
}

describe('Agents list blank-body invariant (256-case)', () => {
  it('never renders nothing when history and tray are both empty', () => {
    for (const inputs of allCases()) {
      const surface = selectSessionListContentSurface({
        isLoading: inputs.isLoading,
        isError: inputs.isError,
        hasAnySessions: inputs.hasAnySessions,
        hasPinnedActive: inputs.hasPinnedActive,
        hasHistoryContent: inputs.hasHistoryContent,
      });
      const body = selectSessionListBodyModel({
        hasHistoryContent: inputs.hasHistoryContent,
        hasPinnedActive: inputs.hasPinnedActive,
        hasActiveQuery: inputs.hasActiveQuery,
        isSearching: inputs.isSearching,
        isError: inputs.isError,
        activeIsError: inputs.activeIsError,
      });
      const result = renderedBody(surface, body);

      if (!inputs.hasHistoryContent && !inputs.hasPinnedActive) {
        expect(
          result,
          `The Agents body would render nothing for ${JSON.stringify(inputs)}`
        ).not.toBe('nothing');
      }
    }
  });

  it('renders nothing only when rows or the tray fill the body', () => {
    for (const inputs of allCases()) {
      const surface = selectSessionListContentSurface({
        isLoading: inputs.isLoading,
        isError: inputs.isError,
        hasAnySessions: inputs.hasAnySessions,
        hasPinnedActive: inputs.hasPinnedActive,
        hasHistoryContent: inputs.hasHistoryContent,
      });
      const body = selectSessionListBodyModel({
        hasHistoryContent: inputs.hasHistoryContent,
        hasPinnedActive: inputs.hasPinnedActive,
        hasActiveQuery: inputs.hasActiveQuery,
        isSearching: inputs.isSearching,
        isError: inputs.isError,
        activeIsError: inputs.activeIsError,
      });
      const result = renderedBody(surface, body);

      if (result === 'nothing') {
        expect(
          inputs.hasHistoryContent || inputs.hasPinnedActive,
          `rendered nothing but hasHistoryContent=false and hasPinnedActive=false for ${JSON.stringify(inputs)}`
        ).toBe(true);
      }
    }
  });
});
