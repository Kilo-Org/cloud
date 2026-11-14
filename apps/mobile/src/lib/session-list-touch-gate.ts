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

/** One armed hold, kept so it can be ended without waiting for its timer. */
type SessionListTouchHold = { end: () => void };

const holds = new Set<SessionListTouchHold>();

/**
 * Shuts the gate for `durationMs`; the returned release ends the hold sooner.
 *
 * Each Clear press arms its own hold, so overlapping presses keep the gate shut
 * until the last one expires instead of the first timeout opening it.
 */
export function holdSessionListTouch(
  durationMs: number = SESSION_LIST_TOUCH_SETTLE_MS
): () => void {
  const hold: SessionListTouchHold = {
    end: () => {
      if (!holds.delete(hold)) {
        return;
      }
      clearTimeout(timer);
    },
  };
  const timer = setTimeout(hold.end, durationMs);
  holds.add(hold);
  return hold.end;
}

/** Whether a touch that starts now must be kept from the session list. */
export function isSessionListTouchHeld(): boolean {
  return holds.size > 0;
}

/**
 * Test-only reset; the holds are module state that outlives a mounted tree, so
 * each armed hold's timer is cleared here instead of firing into a later test.
 */
export function __resetSessionListTouchGateForTests(): void {
  for (const hold of holds) {
    hold.end();
  }
  holds.clear();
}
