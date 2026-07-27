import { describe, expect, it } from 'vitest';

import {
  buildDiffLineAccessibilityLabel,
  diffLineMarker,
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

  // Regression guard: if a future refactor decouples the label from the
  // parsed type, screen readers could report "Added" for a deleted line
  // — which would be worse than the color-only fallback it replaces.
  it('is derived from the parsed type — same input yields the same label, type drives the word', () => {
    const added = makeLine({ type: 'add', newLine: 1, text: 'x' });
    const deleted = makeLine({ type: 'del', oldLine: 1, text: 'x' });
    expect(buildDiffLineAccessibilityLabel(added)).toBe(buildDiffLineAccessibilityLabel(added));
    expect(buildDiffLineAccessibilityLabel(added).startsWith('Added')).toBe(true);
    expect(buildDiffLineAccessibilityLabel(deleted).startsWith('Deleted')).toBe(true);
  });
});
