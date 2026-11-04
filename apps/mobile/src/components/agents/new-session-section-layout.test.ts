import { describe, expect, it } from 'vitest';

import {
  NEW_SESSION_SECTION_LABEL_WIDTH_RATIO,
  resolveNewSessionInlineSections,
} from './new-session-section-layout';

describe('resolveNewSessionInlineSections', () => {
  it('puts the headings beside their controls on the compact design-gate window', () => {
    // The cell where the stacked form ended its first screenful on the
    // `Repository` heading with the picker cut by the pinned footer.
    expect(resolveNewSessionInlineSections(360, 640, 1)).toBe(true);
    // The heading's share there is what the rule is measured against: 45% of
    // the 331.81 dp row the cell measures, which is 149 points of text — the
    // room the 144-point word needs.
    expect((360 - 28) * NEW_SESSION_SECTION_LABEL_WIDTH_RATIO).toBeCloseTo(149.4, 5);
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

  it('keeps the stacked heading where the share cannot hold one word', () => {
    // The row is the window less the form's 28 dp of horizontal padding, so
    // 348 dp is the smallest window whose 45% share still holds a word of the
    // longest localized heading; below it, and on the split-screen and
    // cover-display windows the repo names, the form scrolls the picker into
    // view instead.
    expect(resolveNewSessionInlineSections(348, 640, 1)).toBe(true);
    expect(resolveNewSessionInlineSections(347, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(320, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(240, 640, 1)).toBe(false);
    expect(resolveNewSessionInlineSections(160, 640, 1)).toBe(false);
  });

  it('judges the heading share by the font scale, so large text keeps the stacked form', () => {
    // The same 360 dp cell at the system's own large-text steps: the share
    // shrinks with the scale, so the row stops holding a word just above 1.03
    // and the stacked form returns.
    expect(resolveNewSessionInlineSections(360, 640, 1)).toBe(true);
    // (360 - 28) * 0.45 is 149.4 dp, so the last scale that still holds a
    // 144 dp word is ~1.037; Android's first step above 1.0 (1.15) stacks.
    expect(resolveNewSessionInlineSections(360, 640, 1.03)).toBe(true);
    expect(resolveNewSessionInlineSections(360, 640, 1.15)).toBe(false);
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
