// Comment body field geometry (drain work item: long text must stay
// readable): the max height is a whole-line multiple of the 20pt line box plus
// its 12pt vertical padding, per keyboard state, so the bottom line is never
// sliced mid-glyph, and the keyboard-open cap still keeps the footer CTAs on
// screen at scroll offset 0.

import { describe, expect, it } from 'vitest';

import {
  BODY_LINE_HEIGHT,
  BODY_MAX_LINES_CLOSED,
  BODY_MAX_LINES_OPEN,
  BODY_VERTICAL_PADDING,
  resolveCommentBodyMaxHeight,
} from './comment-body-geometry';

describe('resolveCommentBodyMaxHeight', () => {
  it('adds the vertical padding around a whole number of line boxes', () => {
    const closed = resolveCommentBodyMaxHeight(BODY_MAX_LINES_CLOSED);
    const open = resolveCommentBodyMaxHeight(BODY_MAX_LINES_OPEN);
    expect(closed).toBe(BODY_MAX_LINES_CLOSED * BODY_LINE_HEIGHT + BODY_VERTICAL_PADDING);
    expect(open).toBe(BODY_MAX_LINES_OPEN * BODY_LINE_HEIGHT + BODY_VERTICAL_PADDING);
    // Whole-line invariants: subtracting the padding leaves an exact multiple
    // of the line box, so the bottom line can never be sliced mid-glyph.
    expect((closed - BODY_VERTICAL_PADDING) % BODY_LINE_HEIGHT).toBe(0);
    expect((open - BODY_VERTICAL_PADDING) % BODY_LINE_HEIGHT).toBe(0);
  });

  it('grows the keyboard-open cap to four whole lines (92) from the old 64', () => {
    expect(resolveCommentBodyMaxHeight(BODY_MAX_LINES_OPEN)).toBe(92);
  });

  it('keeps the keyboard-closed cap at ten whole lines (212)', () => {
    expect(resolveCommentBodyMaxHeight(BODY_MAX_LINES_CLOSED)).toBe(212);
  });
});
