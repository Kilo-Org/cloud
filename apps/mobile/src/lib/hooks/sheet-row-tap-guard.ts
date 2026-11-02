/**
 * Tap-burst guard for a list whose row actions sit underneath a form sheet.
 *
 * A sheet dismisses natively: the presses that arrive while it animates out are
 * not delivered to the sheet, and by the time the second press of a double tap
 * lands the list beneath it is hittable again. That press was aimed at the
 * sheet's Save (or Done) control, never at a row, so a save that closes its own
 * sheet on the first press must not let the second one delete the row that was
 * just saved.
 *
 * The guard therefore ignores row presses for a short window after a sheet
 * closed. It rejects a press, it never delays one: nothing is queued, so a
 * dropped press leaves no state behind.
 *
 * No React here. Each screen keeps one state object in a ref and reads the
 * clock at the press, so the window needs no re-render and no timer.
 */

/**
 * How long a row ignores presses after its sheet closed. It covers the native
 * dismiss animation plus the gap a double tap spans (Android's double-tap
 * timeout is 300 ms), and is short enough that a deliberate press right after
 * closing a sheet is still accepted.
 */
export const SHEET_ROW_TAP_GUARD_MS = 500;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type SheetRowTapGuardState = {
  /** `Date.now()` of the last sheet close. `0` means no sheet has closed yet. */
  closedAt: number;
};

/** Seed the state a screen passes to `useRef`. */
export function createSheetRowTapGuardState(): SheetRowTapGuardState {
  return { closedAt: 0 };
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
 * `true` when this press is the user's intent rather than the tail of the burst
 * that dismissed the sheet. Every row action asks before it acts.
 */
export function claimRowPress(state: SheetRowTapGuardState, now: number): boolean {
  return now - state.closedAt >= SHEET_ROW_TAP_GUARD_MS;
}
