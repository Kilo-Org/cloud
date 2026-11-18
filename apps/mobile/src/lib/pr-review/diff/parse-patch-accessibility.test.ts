import { describe, expect, it } from 'vitest';

import {
  buildDiffLineAccessibilityLabel,
  diffLineMarker,
  diffLineNumber,
  diffLineStatusWord,
  type ParsedDiffLine,
} from './parse-patch';

describe('diffLineStatusWord', () => {
  it('maps every line type to its screen-reader status word', () => {
    expect(diffLineStatusWord('add')).toBe('Added');
    expect(diffLineStatusWord('del')).toBe('Deleted');
    expect(diffLineStatusWord('context')).toBe('Context');
  });
});

describe('diffLineMarker', () => {
  it('returns "+" / "-" / "·" for add / del / context (the non-color signal)', () => {
    expect(diffLineMarker('add')).toBe('+');
    expect(diffLineMarker('del')).toBe('-');
    expect(diffLineMarker('context')).toBe('·');
  });
});

type LineOverrides = Partial<ParsedDiffLine>;
function makeLine(overrides: LineOverrides = {}): ParsedDiffLine {
  return { type: 'context', text: '', noNewlineAtEndOfFile: false, ...overrides };
}

describe('diffLineNumber', () => {
  // One rule for the drawn number and the spoken one: new-file numbering,
  // which only the deleted rows lack.
  it('gives every line type the number the row draws and announces', () => {
    expect(diffLineNumber(makeLine({ type: 'add', newLine: 7 }))).toBe(7);
    expect(diffLineNumber(makeLine({ type: 'del', oldLine: 12 }))).toBe(12);
    expect(diffLineNumber(makeLine({ type: 'context', oldLine: 3, newLine: 9 }))).toBe(9);
  });

  it('is undefined for a synthetic line without a number', () => {
    expect(diffLineNumber(makeLine({ type: 'add' }))).toBeUndefined();
  });
});

describe('buildDiffLineAccessibilityLabel', () => {
  // Every test asserts BOTH the status word (the non-color signal) and
  // the line text (the actual content) — the two halves of the a11y
  // label that replaced the color-only fallback.
  it('includes the status word AND the line text for every line type', () => {
    expect(
      buildDiffLineAccessibilityLabel(
        makeLine({ type: 'add', newLine: 7, text: 'export const x = 1;' })
      )
    ).toBe('Added line 7: export const x = 1;');
    expect(
      buildDiffLineAccessibilityLabel(makeLine({ type: 'del', oldLine: 12, text: 'bye' }))
    ).toBe('Deleted line 12: bye');
    expect(
      buildDiffLineAccessibilityLabel(
        makeLine({ type: 'context', oldLine: 1, newLine: 1, text: 'ctx' })
      )
    ).toBe('Context line 1: ctx');
  });

  it('omits the line number when the parsed line has none', () => {
    expect(buildDiffLineAccessibilityLabel(makeLine({ type: 'add', text: 'untracked' }))).toBe(
      'Added: untracked'
    );
  });

  it('prefers the new line number when both old and new are present (context lines)', () => {
    expect(
      buildDiffLineAccessibilityLabel(
        makeLine({ type: 'context', oldLine: 3, newLine: 9, text: 'shared' })
      )
    ).toBe('Context line 9: shared');
  });

  it('renders empty / whitespace-only text as "(empty)" so the label is never silent', () => {
    expect(buildDiffLineAccessibilityLabel(makeLine({ type: 'add', newLine: 4, text: '' }))).toBe(
      'Added line 4: (empty)'
    );
    expect(
      buildDiffLineAccessibilityLabel(makeLine({ type: 'del', oldLine: 2, text: '   \t  ' }))
    ).toBe('Deleted line 2: (empty)');
  });
});
