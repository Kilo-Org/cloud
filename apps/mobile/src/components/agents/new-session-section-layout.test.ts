import { describe, expect, it } from 'vitest';

import {
  NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT,
  resolveNewSessionInlineSections,
} from './new-session-section-layout';

describe('resolveNewSessionInlineSections', () => {
  it('puts the headings beside their controls on the compact design-gate window', () => {
    // The cell where the stacked form ended its first screenful on the
    // `Repository` heading with the picker cut by the pinned footer.
    expect(resolveNewSessionInlineSections(640)).toBe(true);
  });

  it('keeps the stacked heading on the windows that already reach the picker', () => {
    // The base design-gate cell, and the phone windows whose taller frame holds
    // the composer's floor and the picker together.
    expect(resolveNewSessionInlineSections(914)).toBe(false);
    expect(resolveNewSessionInlineSections(NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT)).toBe(
      false
    );
    expect(resolveNewSessionInlineSections(1024)).toBe(false);
  });

  it('engages just below the threshold, where a merged heading still buys the picker room', () => {
    expect(resolveNewSessionInlineSections(NEW_SESSION_INLINE_SECTION_MAX_WINDOW_HEIGHT - 1)).toBe(
      true
    );
  });

  it('keeps the stacked form when the window height is unusable', () => {
    // An absent or non-physical height must not flip the form's layout on a
    // platform that reports none.
    expect(resolveNewSessionInlineSections(0)).toBe(false);
    expect(resolveNewSessionInlineSections(-1)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.NaN)).toBe(false);
    expect(resolveNewSessionInlineSections(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
