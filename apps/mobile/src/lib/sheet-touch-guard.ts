import { useLayoutEffect } from 'react';

/**
 * How long a sheet is given to create its own window and take the touch itself.
 *
 * Measured on the Android emulator: a tap ~320 ms after the open request still
 * reached the tab bar behind the sheet, one at ~500 ms reached the sheet. The
 * bound is that handover plus a margin for a slower device; until it ends the
 * sheet is still sliding in, so keeping it short also keeps the sheet's own
 * controls from being unreachable for long after they are visible.
 */
export const SHEET_TOUCH_HOLD_MS = 800;

/**
 * Whether a native sheet has been asked for but its own window does not take
 * touch yet.
 *
 * A sheet's dialog window is created after its component commits, and until it
 * exists the app window still owns touch: a tap made while the sheet opens
 * lands on the screen behind it — the tab bar included. The app root wraps its
 * content in a gate that reads this at touch arrival (`SheetTouchGuard`), which
 * is what makes the window safe: a layer that has to be mounted first is in the
 * touch path after the touch it should have claimed.
 *
 * The hold is bounded because the sheet's own content is part of the app's
 * React tree: a gate that never let go would swallow the sheet's own buttons
 * too (measured on the emulator: a press on the sheet's Cancel reached the gate
 * with the sheet's own coordinates). It only has to cover the handover, after
 * which the sheet's separate window takes every touch itself.
 */
let holds = 0;

/** Holds the gate for `durationMs`; the returned release ends it sooner. */
export function holdSheetTouch(durationMs = SHEET_TOUCH_HOLD_MS): () => void {
  holds += 1;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    holds -= 1;
  };
  const timer = setTimeout(release, durationMs);
  return () => {
    clearTimeout(timer);
    release();
  };
}

/** Whether a touch that starts now must be kept from what it lands on. */
export function isSheetTouchHeld(): boolean {
  return holds > 0;
}

/** Holds the gate for as long as the caller's sheet is presented. */
export function useSheetTouchHold(presented: boolean): void {
  useLayoutEffect(() => (presented ? holdSheetTouch() : undefined), [presented]);
}
