import { describe, expect, it } from 'vitest';

import { buildContextWindow } from './context-window';

describe('buildContextWindow', () => {
  it('builds the first window from the gap start', () => {
    expect(
      buildContextWindow({ startLine: 10, endLine: 100, alreadyLoaded: 0, windowSize: 20 })
    ).toEqual({ startLine: 10, endLine: 29 });
  });

  it('builds a continuation window after already-loaded lines', () => {
    expect(
      buildContextWindow({ startLine: 10, endLine: 100, alreadyLoaded: 20, windowSize: 20 })
    ).toEqual({ startLine: 30, endLine: 49 });
  });

  it('clamps the window by the gap endLine', () => {
    expect(
      buildContextWindow({ startLine: 90, endLine: 100, alreadyLoaded: 0, windowSize: 20 })
    ).toEqual({ startLine: 90, endLine: 100 });
  });
});
