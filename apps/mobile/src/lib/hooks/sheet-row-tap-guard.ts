import { insideBurstWindow } from './burst-window';

/**
 * Tap-burst guard for a list that a push or a sheet hands the reader back to.
 *
 * A reader is handed back to a list two ways: an editor sheet dismisses, or the
 * pushed child screen that held the control closes itself. Both are native
 * transitions: the presses that arrive while one animates out are not delivered
 * to the surface that is leaving, and by the time the second press of a double
 * tap lands the list beneath it is hittable again. That press was aimed at the
 * control that dismissed or closed, never at a row or a header action, so the
 * second press of a fast double tap on Save must not open the row behind it.
 *
 * The guard therefore ignores every press for a short window after either
 * hand-back. It rejects a press, it never delays one: nothing is queued, so a
 * dropped press leaves no state behind.
 *
 * No React here. Each screen keeps one state object in a ref and reads the
 * clock at the press, so the window needs no re-render and no timer.
 */

/**
 * How long a screen ignores presses after it is handed back to the reader —
 * a sheet closed, or a pushed child screen closed itself. It covers the native
 * dismiss animation plus the gap a double tap spans (Android's double-tap
 * timeout is 300 ms), and is short enough that a deliberate press right after
 * the hand-back is still accepted.
 */
export const SHEET_ROW_TAP_GUARD_MS = 500;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type SheetRowTapGuardState = {
  /** `Date.now()` of the last sheet close. `0` means no sheet has closed yet. */
  closedAt: number;
  /** `Date.now()` of the last return to the screen. `0` means it never returned. */
  returnedAt: number;
};

/** Seed the state a screen passes to `useRef`. */
export function createSheetRowTapGuardState(): SheetRowTapGuardState {
  return { closedAt: 0, returnedAt: 0 };
}

/**
 * Record that a sheet just closed. Called from the one close path of the
 * screen, so every way out of the sheet (Save, Cancel, Back, a refused edit)
 * arms the guard.
 */
export function markSheetClosed(state: SheetRowTapGuardState, now: number): void {
  state.closedAt = now;
}

/**
 * Record that the screen just regained focus from a child it pushed. Called on
 * every focus after the first, so a fresh mount does not deaden its own rows.
 */
export function markScreenReturned(state: SheetRowTapGuardState, now: number): void {
  state.returnedAt = now;
}

/**
 * `true` when this press is the user's intent rather than the tail of the burst
 * that closed a sheet or a child screen. Every press surface asks before it
 * acts.
 */
export function claimRowPress(state: SheetRowTapGuardState, now: number): boolean {
  return (
    !insideBurstWindow(state.closedAt, now, SHEET_ROW_TAP_GUARD_MS) &&
    !insideBurstWindow(state.returnedAt, now, SHEET_ROW_TAP_GUARD_MS)
  );
}
