import { describe, expect, it } from 'vitest';

import { hasActiveInteraction, pickActiveInteractionSurface } from './interaction-surface';

describe('pickActiveInteractionSurface', () => {
  it('returns none when no interaction is active', () => {
    expect(
      pickActiveInteractionSurface({
        activeQuestion: null,
        activePermission: null,
        activeSuggestion: null,
      })
    ).toEqual({ kind: 'none' });
  });

  it('prefers question over permission and suggestion', () => {
    expect(
      pickActiveInteractionSurface({
        activeQuestion: { requestId: 'q-1' },
        activePermission: { requestId: 'p-1' },
        activeSuggestion: { requestId: 's-1' },
      })
    ).toEqual({ kind: 'question' });
  });

  it('prefers permission over suggestion', () => {
    expect(
      pickActiveInteractionSurface({
        activeQuestion: null,
        activePermission: { requestId: 'p-1' },
        activeSuggestion: { requestId: 's-1' },
      })
    ).toEqual({ kind: 'permission' });
  });

  it('returns suggestion when no question or permission is active', () => {
    expect(
      pickActiveInteractionSurface({
        activeQuestion: null,
        activePermission: null,
        activeSuggestion: { requestId: 's-1' },
      })
    ).toEqual({ kind: 'suggestion' });
  });
});

describe('hasActiveInteraction', () => {
  it('is true when only suggestion is active so the composer is hidden', () => {
    expect(
      hasActiveInteraction({
        activeQuestion: null,
        activePermission: null,
        activeSuggestion: { requestId: 's-1' },
      })
    ).toBe(true);
  });

  it('is false when no interaction is active so the composer can render', () => {
    expect(
      hasActiveInteraction({
        activeQuestion: null,
        activePermission: null,
        activeSuggestion: null,
      })
    ).toBe(false);
  });
});
