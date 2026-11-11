/**
 * How long a session list keeps a touch off its body after a Clear action
 * replaced that body in place.
 *
 * Measured on the Android emulator: the no-match body's Clear action swaps the
 * empty state for the row list in the same commit, so a session row lands under
 * the point the finger just released. A repeat tap behind the Clear tap opened
 * that row and left the list; measured gaps of 500, 600 and 700 ms all opened
 * one, and 400 ms was a race with the row mount. The bound covers those repeats
 * with margin and matches the hold `sheet-touch-guard.ts` measured for the same
 * kind of handover; it still ends well before a user can read a row to tap it.
 */
export const SESSION_LIST_TOUCH_SETTLE_MS = 800;

let holds = 0;

/**
 * Shuts the gate for `durationMs`; the returned release ends the hold sooner.
 *
 * Each Clear press arms its own hold, so overlapping presses keep the gate shut
 * until the last one expires instead of the first timeout opening it.
 */
export function holdSessionListTouch(
  durationMs: number = SESSION_LIST_TOUCH_SETTLE_MS
): () => void {
  holds += 1;
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    // A test reset clears the count while a timer is still armed; a late
    // release must not drive the gate below open.
    holds = Math.max(0, holds - 1);
  };
  const timer = setTimeout(release, durationMs);
  return () => {
    clearTimeout(timer);
    release();
  };
}

/** Whether a touch that starts now must be kept from the session list. */
export function isSessionListTouchHeld(): boolean {
  return holds > 0;
}

/** Test-only reset; the holds are module state that outlives a mounted tree. */
export function __resetSessionListTouchGateForTests(): void {
  holds = 0;
}
