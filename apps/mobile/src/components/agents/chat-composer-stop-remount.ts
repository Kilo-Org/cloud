/**
 * Stop-remount state machine for the chat composer input row (Item 14 E2E
 * gate).  iOS leaves a multiline TextInput non-interactive after the
 * editable=false→true flip that happens when the SDK restores the composer
 * post-interrupt.  The fix is to remount the input row only after the
 * disable-then-clear sequence completes, so the new mount starts with
 * editable=true.
 *
 * Phases:
 * - idle:    no Stop in flight.
 * - armed:   handleStop called; waiting to observe disabled===true.
 * - locked:  disabled observed true; waiting for it to clear back to false.
 *
 * A synchronous onStop that fails or early-returns (disabled never becomes
 * true) leaves the machine in armed indefinitely.  That is safe: the
 * component remains interactive, and a subsequent Stop press re-arms
 * idempotently.  No timeout is needed — the armed phase is a harmless
 * no-op until disabled actually engages.
 */
export type StopRemountPhase = 'idle' | 'armed' | 'locked';

export type StopRemountTransition = {
  phase: StopRemountPhase;
  /** True when the transition should trigger an input-row remount. */
  shouldRemount: boolean;
};

export function nextStopRemountPhase(
  phase: StopRemountPhase,
  disabled: boolean
): StopRemountTransition {
  if (phase === 'idle') {
    return { phase: 'idle', shouldRemount: false };
  }

  if (phase === 'armed') {
    if (disabled) {
      return { phase: 'locked', shouldRemount: false };
    }
    return { phase: 'armed', shouldRemount: false };
  }

  // phase === 'locked'
  if (disabled) {
    return { phase: 'locked', shouldRemount: false };
  }

  return { phase: 'idle', shouldRemount: true };
}
