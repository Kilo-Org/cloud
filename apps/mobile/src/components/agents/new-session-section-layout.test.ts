import { describe, expect, it } from 'vitest';

import {
  NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT,
  resolveNewSessionInlineSections,
} from './new-session-section-layout';

describe('resolveNewSessionInlineSections', () => {
  it('puts the headings beside their controls on the compact design-gate window', () => {
    // The cell where the stacked form ended its first screenful on the
    // `Repository` heading with the picker cut by the pinned footer.
    expect(resolveNewSessionInlineSections(360, 640)).toBe(true);
  });

  it('keeps the stacked heading on the windows that already reach the picker', () => {
    // The base design-gate cell, and the windows whose taller frame holds the
    // composer's floor and the picker together.
    expect(resolveNewSessionInlineSections(411, 914)).toBe(false);
    expect(resolveNewSessionInlineSections(411, NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT)).toBe(
      false
    );
    expect(resolveNewSessionInlineSections(768, 1024)).toBe(false);
  });

  it('engages just below the threshold, where a merged heading still buys the picker room', () => {
    expect(
      resolveNewSessionInlineSections(411, NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT - 1)
    ).toBe(true);
  });

  it('takes the compact row in landscape too, where the form frame is shortest', () => {
    // A landscape phone and a landscape tablet are short by height, not wide
    // enough to be a phone only: the row is what keeps the picker reachable.
    expect(resolveNewSessionInlineSections(914, 411)).toBe(true);
    expect(resolveNewSessionInlineSections(1024, 600)).toBe(true);
  });

  it('keeps the stacked heading where a fixed heading would starve the control', () => {
    // `narrow-layout`'s threshold: below 240 dp the heading beside a `flex-1`
    // control leaves it no room for a word, so those windows scroll instead.
    expect(resolveNewSessionInlineSections(239, 640)).toBe(false);
    expect(resolveNewSessionInlineSections(160, 640)).toBe(false);
  });

  it('keeps the stacked form when a dimension is unusable', () => {
    // An absent or non-physical window must not flip the form's layout on a
    // platform that reports none.
    expect(resolveNewSessionInlineSections(360, 0)).toBe(false);
    expect(resolveNewSessionInlineSections(360, -1)).toBe(false);
    expect(resolveNewSessionInlineSections(360, Number.NaN)).toBe(false);
    expect(resolveNewSessionInlineSections(360, Number.POSITIVE_INFINITY)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.NaN, 640)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.POSITIVE_INFINITY, 640)).toBe(false);
  });
});
