import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DESTRUCTIVE_TOUCH_ADMISSION_MS,
  holdDestructiveTouch,
  holdSheetTouch,
  isDestructiveTouchPending,
  isSheetTouchHeld,
  SHEET_TOUCH_HOLD_MS,
} from '@/lib/sheet-touch-guard';

afterEach(() => {
  vi.useRealTimers();
});

describe('sheet touch hold', () => {
  it('keeps the gate shut until the release runs', () => {
    const release = holdSheetTouch();
    expect(isSheetTouchHeld()).toBe(true);

    release();
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('opens the gate on its own once the sheet has had the window', () => {
    vi.useFakeTimers();
    holdSheetTouch();
    expect(isSheetTouchHeld()).toBe(true);

    // The sheet's own window takes touch after the handover, so the gate must
    // let go: its content is part of the app tree and needs its presses back.
    vi.advanceTimersByTime(SHEET_TOUCH_HOLD_MS + 1);

    expect(isSheetTouchHeld()).toBe(false);
  });

  it('keeps the gate shut while another sheet is still inside its window', () => {
    vi.useFakeTimers();
    const releaseFirst = holdSheetTouch();
    holdSheetTouch();

    releaseFirst();
    expect(isSheetTouchHeld()).toBe(true);

    vi.advanceTimersByTime(SHEET_TOUCH_HOLD_MS + 1);
    expect(isSheetTouchHeld()).toBe(false);
  });

  it('releases at most once per hold', () => {
    const release = holdSheetTouch();
    release();
    release();

    expect(isSheetTouchHeld()).toBe(false);

    const next = holdSheetTouch();
    expect(isSheetTouchHeld()).toBe(true);
    next();
    expect(isSheetTouchHeld()).toBe(false);
  });

  // The window is what keeps a press made while a sheet opens off the screen
  // behind it, and it is also what makes the sheet's own controls dead: its
  // content is part of the same tree, so a press on a confirm's Cancel is
  // claimed for as long as the window runs. Measured on the Android emulator
  // (the readings are in `@/lib/sheet-touch-guard`): touch reaches a presented
  // sheet at ~500 ms and its buttons are painted before that. A window longer
  // than the handover keeps Cancel and Close inert after the reader can see and
  // aim at them, which is the defect this pins.
  it('lets the sheet take its own presses once touch has handed over', () => {
    expect(SHEET_TOUCH_HOLD_MS).toBeLessThanOrEqual(500);
  });
});

describe('destructive touch admission', () => {
  // A destructive choice must outlast the gate, not match it: a press aimed at
  // Cancel signs the reader out about once in 23 presses in the band where a
  // sheet is still moving (measured on the emulator), and one more press is the
  // cheaper outcome.
  it('outlasts the opening window', () => {
    expect(DESTRUCTIVE_TOUCH_ADMISSION_MS).toBeGreaterThan(SHEET_TOUCH_HOLD_MS);
  });

  it('declines presses while a fresh sheet is still moving, then admits them', () => {
    vi.useFakeTimers();
    const release = holdDestructiveTouch();
    expect(isDestructiveTouchPending()).toBe(true);

    vi.advanceTimersByTime(DESTRUCTIVE_TOUCH_ADMISSION_MS + 1);
    expect(isDestructiveTouchPending()).toBe(false);
    release();
  });

  it('ends the hold when the caller unmounts before the window closes', () => {
    vi.useFakeTimers();
    const release = holdDestructiveTouch();
    expect(isDestructiveTouchPending()).toBe(true);

    // A dismissed sheet must not leave the next one refusing presses.
    release();
    expect(isDestructiveTouchPending()).toBe(false);
    vi.advanceTimersByTime(DESTRUCTIVE_TOUCH_ADMISSION_MS + 1);
    expect(isDestructiveTouchPending()).toBe(false);
  });

  it('stays closed while any presented sheet is still inside its admission', () => {
    vi.useFakeTimers();
    const first = holdDestructiveTouch();
    holdDestructiveTouch();

    first();
    expect(isDestructiveTouchPending()).toBe(true);

    vi.advanceTimersByTime(DESTRUCTIVE_TOUCH_ADMISSION_MS + 1);
    expect(isDestructiveTouchPending()).toBe(false);
  });
});
