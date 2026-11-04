import { describe, expect, it } from 'vitest';

import { resolveNewSessionInlineSections } from './new-session-section-layout';

describe('resolveNewSessionInlineSections', () => {
  it('puts the headings beside their controls on the compact design-gate window', () => {
    // The cell where the stacked form ended its first screenful on the
    // `Repository` heading with the picker cut by the pinned footer.
    expect(resolveNewSessionInlineSections(360, 640, 1)).toBe(true);
  });

  it('keeps the stacked heading on the windows that already reach the picker', () => {
    // The base design-gate cell, and the windows whose taller frame holds the
    // composer's floor and the picker together.
    expect(resolveNewSessionInlineSections(411, 914, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(411, 720, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(768, 1024, 1)).toBe(false);
  });

  it('engages just below the threshold, where a merged heading still buys the picker room', () => {
    expect(resolveNewSessionInlineSections(411, 719, 1)).toBe(true);
  });

  it('takes the compact row in landscape too, where the form frame is shortest', () => {
    // A landscape phone and a landscape tablet are short by height: the row is
    // what keeps the picker reachable there.
    expect(resolveNewSessionInlineSections(914, 411, 1)).toBe(true);
    expect(resolveNewSessionInlineSections(1024, 600, 1)).toBe(true);
  });

  it('keeps the stacked heading where a shortened heading would break a word', () => {
    // The narrowest common phone is the smallest row that still holds one word
    // of a long localized heading in its 45% share; below it, and on the
    // split-screen and cover-display windows the repo names, the form scrolls
    // the picker into view instead.
    expect(resolveNewSessionInlineSections(320, 640, 1)).toBe(true);
    expect(resolveNewSessionInlineSections(319, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(240, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(160, 640, 1)).toBe(false);
  });

  it('judges the row in points of text, so a large font scale keeps the stacked form', () => {
    // The same 360 dp cell at the system's own large-text steps: the heading's
    // room shrinks with the scale, so the row stops holding a word at scale
    // 1.25 and beyond, and the stacked form returns.
    expect(resolveNewSessionInlineSections(360, 640, 1)).toBe(true);
    expect(resolveNewSessionInlineSections(360, 640, 1.125)).toBe(true);
    expect(resolveNewSessionInlineSections(360, 640, 1.25)).toBe(false);
    expect(resolveNewSessionInlineSections(360, 640, 1.8)).toBe(false);
    // A wider phone keeps the row further up the scale before it stops.
    expect(resolveNewSessionInlineSections(480, 640, 1.4)).toBe(true);
  });

  it('keeps the stacked form when a dimension or the scale is unusable', () => {
    // An absent or non-physical value must not flip the form's layout on a
    // platform that reports none.
    expect(resolveNewSessionInlineSections(360, 0, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(360, -1, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(360, Number.NaN, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(360, Number.POSITIVE_INFINITY, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.NaN, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.POSITIVE_INFINITY, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(360, 640, 0)).toBe(false);
    expect(resolveNewSessionInlineSections(360, 640, Number.NaN)).toBe(false);
  });
});
