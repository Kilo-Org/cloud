import { useLayoutEffect } from 'react';

/**
 * How long a sheet is given to hand touch over to its own window — when it
 * opens, and again when it dismisses and reports the finished dismissal.
 *
 * Measured on the Android emulator: a tap ~320 ms after the open request still
 * reached the tab bar behind the sheet, one at ~500 ms reached the sheet. The
 * bound is that handover plus a margin for a slower device; until it ends the
 * sheet is still sliding in, so keeping it short also keeps the sheet's own
 * controls from being unreachable for long after they are visible.
 */
export const SHEET_TOUCH_HOLD_MS = 800;

/**
 * How long the gate stays shut after the native sheet reports its dismissal
 * finished. The sheet's own window is already gone when the report arrives,
 * so the frames right behind it would land on the screen behind the sheet.
 */
export const SHEET_TOUCH_SETTLE_MS = 120;

/**
 * Whether a native sheet is in one of the two windows in which its own window
 * does not take touch: while it opens, and while it dismisses.
 *
 * A sheet's dialog window is created after its component commits, and until it
 * exists the app window still owns touch: a tap made while the sheet opens
 * lands on the screen behind it — the tab bar included. The app root wraps its
 * content in a gate that reads this at touch arrival (`SheetTouchGuard`), which
 * is what makes the window safe: a layer that has to be mounted first is in the
 * touch path after the touch it should have claimed.
 *
 * The dismissal has a settle window at its other end. Measured on the emulator
 * with this gate's own logs: the sheet's dialog window left the touch path
 * while the report that ends a close-request lease was still in flight, and a
 * second tap, a few frames behind the one that pressed the sheet's Apply,
 * opened the row that sat underneath the button and launched an unrelated
 * session. The report is therefore not the only end: `Sheet` ends that lease
 * and holds the settle window from it (see `SHEET_TOUCH_SETTLE_MS`), so the
 * frames behind the gone window land on this gate instead of the row.
 *
 * Each hold is bounded because the sheet's own content is part of the app's
 * React tree: a gate that never let go would swallow the sheet's own buttons
 * too (measured on the emulator: a press on the sheet's Cancel reached the gate
 * with the sheet's own coordinates), and a dismissal the platform never reports
 * must not keep the screen behind it dead.
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

/**
 * Holds the gate while the caller's sheet is in one of its two in-flight
 * windows: `opening` from the present request until its own window takes touch,
 * `dismissing` from the close request until the native sheet reports the
 * dismissal finished.
 *
 * Each window arms its own hold, so a close that lands while the open hold is
 * still running keeps the gate shut, and a dismissal long after the open hold
 * ended arms a fresh one.
 */
export function useSheetTouchHold(
  windows: Readonly<{ opening: boolean; dismissing: boolean }>
): void {
  const { opening, dismissing } = windows;
  useLayoutEffect(() => (opening ? holdSheetTouch() : undefined), [opening]);
  useLayoutEffect(() => (dismissing ? holdSheetTouch() : undefined), [dismissing]);
}
