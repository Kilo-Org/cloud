// Comment body field geometry (drain work item: long text must stay
// readable): the max height is a whole-line multiple of the 20pt line box plus
// its 12pt vertical padding, per keyboard state, so the bottom line is never
// sliced mid-glyph, and the keyboard-open cap still keeps the footer CTAs on
// screen at scroll offset 0.

import { describe, expect, it } from 'vitest';

import {
  BODY_BORDER_WIDTH,
  BODY_LINE_HEIGHT,
  BODY_MAX_LINES_CLOSED,
  BODY_MAX_LINES_OPEN,
  BODY_VERTICAL_PADDING,
  resolveCommentBodyFade,
  resolveCommentBodyMaxHeight,
  resolveFadeColor,
} from './comment-body-geometry';

describe('resolveCommentBodyMaxHeight', () => {
  it('adds the vertical padding and borders around a whole number of line boxes', () => {
    const inset = BODY_VERTICAL_PADDING + 2 * BODY_BORDER_WIDTH;
    const closed = resolveCommentBodyMaxHeight(BODY_MAX_LINES_CLOSED);
    const open = resolveCommentBodyMaxHeight(BODY_MAX_LINES_OPEN);
    expect(closed).toBe(BODY_MAX_LINES_CLOSED * BODY_LINE_HEIGHT + inset);
    expect(open).toBe(BODY_MAX_LINES_OPEN * BODY_LINE_HEIGHT + inset);
    // Whole-line invariants: subtracting the inset leaves an exact multiple
    // of the line box, so the bottom line can never be sliced mid-glyph.
    expect((closed - inset) % BODY_LINE_HEIGHT).toBe(0);
    expect((open - inset) % BODY_LINE_HEIGHT).toBe(0);
  });

  it('grows the keyboard-open cap to four whole lines (94) from the old 64', () => {
    expect(resolveCommentBodyMaxHeight(BODY_MAX_LINES_OPEN)).toBe(94);
  });

  it('keeps the keyboard-closed cap at ten whole lines (214)', () => {
    expect(resolveCommentBodyMaxHeight(BODY_MAX_LINES_CLOSED)).toBe(214);
  });
});

describe('resolveCommentBodyFade', () => {
  it('shows no fade before the first layout measurement', () => {
    expect(resolveCommentBodyFade({ contentHeight: null, frameHeight: 212 })).toBe(false);
    expect(resolveCommentBodyFade({ contentHeight: 400, frameHeight: null })).toBe(false);
  });

  it('shows no fade while the content fits the frame', () => {
    expect(resolveCommentBodyFade({ contentHeight: 200, frameHeight: 212 })).toBe(false);
  });

  it('shows the fade when the content is taller than the frame', () => {
    expect(resolveCommentBodyFade({ contentHeight: 400, frameHeight: 212 })).toBe(true);
  });
});

describe('resolveFadeColor', () => {
  it('builds an rgba stop from a six-digit hex color', () => {
    expect(resolveFadeColor('#14130F', 0.06)).toBe('rgba(20, 19, 15, 0.06)');
    expect(resolveFadeColor('#FFFFFF', 0)).toBe('rgba(255, 255, 255, 0)');
  });

  it('falls back to black when the color cannot be parsed', () => {
    expect(resolveFadeColor('not-a-color', 0.06)).toBe('rgba(0, 0, 0, 0.06)');
  });
});
