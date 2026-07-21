import { describe, expect, it } from 'vitest';

import {
  addContextLoadState,
  getCumulativeLines,
  setContextLines,
} from '@/lib/pr-review/diff/pr-diff-list-items';

describe('addContextLoadState', () => {
  it('transitions idle to loading with empty lines', () => {
    const next = addContextLoadState({
      state: {},
      filePath: 'a.ts',
      gapIndex: 0,
      status: 'loading',
    });
    expect(next['a.ts']?.[0]).toEqual({ status: 'loading', lines: [] });
  });

  it('preserves existing lines when transitioning partial to loading', () => {
    const state = {
      'a.ts': {
        0: { status: 'partial' as const, lines: ['line1'] },
      },
    };
    const next = addContextLoadState({ state, filePath: 'a.ts', gapIndex: 0, status: 'loading' });
    expect(next['a.ts']?.[0]).toEqual({ status: 'loading', lines: ['line1'] });
  });

  it('preserves existing lines when transitioning partial to error', () => {
    const state = {
      'a.ts': {
        0: { status: 'partial' as const, lines: ['line1'] },
      },
    };
    const next = addContextLoadState({ state, filePath: 'a.ts', gapIndex: 0, status: 'error' });
    expect(next['a.ts']?.[0]).toEqual({ status: 'error', lines: ['line1'] });
  });

  it('clears state when marking unavailable', () => {
    const state = {
      'a.ts': {
        0: { status: 'partial' as const, lines: ['line1'] },
      },
    };
    const next = addContextLoadState({
      state,
      filePath: 'a.ts',
      gapIndex: 0,
      status: 'unavailable',
    });
    expect(next['a.ts']?.[0]).toEqual({ status: 'unavailable' });
  });
});

describe('setContextLines', () => {
  it('sets partial state with lines from idle', () => {
    const next = setContextLines({
      state: {},
      filePath: 'a.ts',
      gapIndex: 0,
      lines: ['line1', 'line2'],
    });
    expect(next['a.ts']?.[0]).toEqual({ status: 'partial', lines: ['line1', 'line2'] });
  });

  it('appends new lines to existing partial state', () => {
    const state = {
      'a.ts': {
        0: { status: 'partial' as const, lines: ['line1'] },
      },
    };
    const next = setContextLines({ state, filePath: 'a.ts', gapIndex: 0, lines: ['line2'] });
    expect(next['a.ts']?.[0]).toEqual({ status: 'partial', lines: ['line1', 'line2'] });
  });

  it('stores totalLines when provided', () => {
    const next = setContextLines({
      state: {},
      filePath: 'a.ts',
      gapIndex: 0,
      lines: ['line1'],
      totalLines: 100,
    });
    expect(next['a.ts']?.[0]).toEqual({ status: 'partial', lines: ['line1'], totalLines: 100 });
  });
});

describe('getCumulativeLines', () => {
  it('returns lines for loading, partial, and error states', () => {
    expect(getCumulativeLines({ status: 'loading', lines: ['a'] })).toEqual(['a']);
    expect(getCumulativeLines({ status: 'partial', lines: ['b'] })).toEqual(['b']);
    expect(getCumulativeLines({ status: 'error', lines: ['c'] })).toEqual(['c']);
  });

  it('returns empty array for idle and unavailable states', () => {
    expect(getCumulativeLines({ status: 'idle' })).toEqual([]);
    expect(getCumulativeLines({ status: 'unavailable' })).toEqual([]);
    expect(getCumulativeLines(undefined)).toEqual([]);
  });
});
