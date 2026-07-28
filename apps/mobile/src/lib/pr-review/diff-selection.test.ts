import { describe, expect, it } from 'vitest';

import {
  clearSelection,
  isLineInSelection,
  type SelectionTap,
  selectLine,
  sideForDiffLineType,
} from '@/lib/pr-review/diff-selection';

function tap(overrides: Partial<SelectionTap> = {}): SelectionTap {
  return {
    path: 'src/foo.ts',
    side: 'RIGHT',
    line: 5,
    hunkKey: 'src/foo.ts:0',
    text: 'line 5',
    ...overrides,
  };
}

function hunkLines(entries: [number, string][]): Map<number, string> {
  return new Map(entries);
}

describe('selectLine', () => {
  it('starts a new single-line selection when state is null', () => {
    const result = selectLine(null, tap({ line: 5, text: 'a' }), hunkLines([]));
    expect(result).toEqual({
      path: 'src/foo.ts',
      side: 'RIGHT',
      hunkKey: 'src/foo.ts:0',
      startLine: 5,
      line: 5,
      selectedText: 'a',
    });
  });

  it('extends the range when tapping the same path/side/hunk in ascending order', () => {
    const first = selectLine(null, tap({ line: 5, text: 'a' }), hunkLines([]));
    const second = selectLine(
      first,
      tap({ line: 7, text: 'c' }),
      hunkLines([
        [5, 'a'],
        [6, 'b'],
        [7, 'c'],
      ])
    );
    expect(second.startLine).toBe(5);
    expect(second.line).toBe(7);
    expect(second.selectedText).toBe('a\nb\nc');
  });

  it('extends the range in descending order, taking min(startLine) and max(line)', () => {
    const first = selectLine(null, tap({ line: 8, text: 'd' }), hunkLines([]));
    const second = selectLine(
      first,
      tap({ line: 5, text: 'a' }),
      hunkLines([
        [5, 'a'],
        [6, 'b'],
        [7, 'c'],
        [8, 'd'],
      ])
    );
    expect(second.startLine).toBe(5);
    expect(second.line).toBe(8);
    expect(second.selectedText).toBe('a\nb\nc\nd');
  });

  it('replaces the selection when tapping the other side (LEFT ↔ RIGHT)', () => {
    const first = selectLine(null, tap({ side: 'RIGHT', line: 5, text: 'a' }), hunkLines([]));
    const second = selectLine(
      first,
      tap({ side: 'LEFT', line: 12, text: 'del-12' }),
      hunkLines([])
    );
    expect(second).toEqual({
      path: 'src/foo.ts',
      side: 'LEFT',
      hunkKey: 'src/foo.ts:0',
      startLine: 12,
      line: 12,
      selectedText: 'del-12',
    });
  });

  it('replaces the selection when crossing to a different hunk', () => {
    const first = selectLine(
      null,
      tap({ line: 5, hunkKey: 'src/foo.ts:0', text: 'a' }),
      hunkLines([])
    );
    const second = selectLine(
      first,
      tap({ line: 30, hunkKey: 'src/foo.ts:1', text: 'x' }),
      hunkLines([])
    );
    expect(second).toEqual({
      path: 'src/foo.ts',
      side: 'RIGHT',
      hunkKey: 'src/foo.ts:1',
      startLine: 30,
      line: 30,
      selectedText: 'x',
    });
  });

  it('replaces the selection when tapping a different file', () => {
    const first = selectLine(null, tap({ path: 'src/a.ts', line: 1, text: 'a' }), hunkLines([]));
    const second = selectLine(first, tap({ path: 'src/b.ts', line: 10, text: 'b' }), hunkLines([]));
    expect(second.path).toBe('src/b.ts');
    expect(second.startLine).toBe(10);
    expect(second.line).toBe(10);
  });

  it('uses the hunk line map for selected text, not the tap text, when the map is complete', () => {
    const first = selectLine(null, tap({ line: 5, text: 'tap-text' }), hunkLines([[5, 'a']]));
    const second = selectLine(
      first,
      tap({ line: 7, text: 'tap-text' }),
      hunkLines([
        [5, 'a'],
        [6, 'b'],
        [7, 'c'],
      ])
    );
    expect(second.selectedText).toBe('a\nb\nc');
  });
});

describe('sideForDiffLineType', () => {
  it('classifies add lines as RIGHT', () => {
    expect(sideForDiffLineType('add')).toBe('RIGHT');
  });

  it('classifies context lines as RIGHT', () => {
    expect(sideForDiffLineType('context')).toBe('RIGHT');
  });

  it('classifies del lines as LEFT', () => {
    expect(sideForDiffLineType('del')).toBe('LEFT');
  });
});

describe('clearSelection', () => {
  it('returns null', () => {
    expect(clearSelection()).toBeNull();
  });
});

describe('isLineInSelection', () => {
  it('returns false when no selection', () => {
    expect(isLineInSelection(null, { line: 5 })).toBe(false);
  });

  it('returns true for a line inside the range', () => {
    const state = {
      path: 'src/foo.ts',
      side: 'RIGHT' as const,
      hunkKey: 'src/foo.ts:0',
      startLine: 5,
      line: 8,
      selectedText: 'a\nb\nc\nd',
    };
    expect(isLineInSelection(state, { line: 5 })).toBe(true);
    expect(isLineInSelection(state, { line: 6 })).toBe(true);
    expect(isLineInSelection(state, { line: 8 })).toBe(true);
  });

  it('returns false for a line outside the range', () => {
    const state = {
      path: 'src/foo.ts',
      side: 'RIGHT' as const,
      hunkKey: 'src/foo.ts:0',
      startLine: 5,
      line: 8,
      selectedText: 'a\nb\nc\nd',
    };
    expect(isLineInSelection(state, { line: 4 })).toBe(false);
    expect(isLineInSelection(state, { line: 9 })).toBe(false);
  });
});
