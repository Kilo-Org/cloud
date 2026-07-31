/**
 * Stop-remount state machine for the chat composer input row (Item 14 E2E
 * gate).  iOS leaves a multiline TextInput non-interactive after the
 * editable=false→true flip that happens when the SDK restores the composer
 * post-interrupt.  The fix is to remount the input row only after the
 * disable-then-clear sequence completes, so the new mount starts with
 * editable=true.
 *
 * The SDK's `interrupt()` writes canSendAtom false→true around an async CLI
 * round-trip.  React may batch both writes into a single render where only
 * the final `disabled=false` commits, so the state machine cannot depend on
 * observing an intermediate `disabled=true` frame.  Instead the component
 * signals `stopCompleted` once the onStop promise settles; the machine then
 * waits for `disabled===false` to trigger the remount.
 *
 * Phases:
 * - idle:    no Stop in flight.
 * - armed:   handleStop called; onStop completion scheduled via microtask.
 * - settled: onStop completed; waiting for disabled===false to remount.
 *
 * The component wraps onStop in an async helper with try/finally, so
 * stopCompleted is always signalled — including after a synchronous onStop,
 * a rejected promise, or a thrown error.  The armed phase is therefore
 * always exited quickly; it never persists indefinitely.
 */
export type StopRemountPhase = 'idle' | 'armed' | 'settled';

export type StopRemountTransition = {
  phase: StopRemountPhase;
  /** True when the transition should trigger an input-row remount. */
  shouldRemount: boolean;
};

export function nextStopRemountPhase(
  phase: StopRemountPhase,
  disabled: boolean,
  stopCompleted: boolean
): StopRemountTransition {
  if (phase === 'idle') {
    return { phase: 'idle', shouldRemount: false };
  }

  if (phase === 'armed') {
    if (!stopCompleted) {
      return { phase: 'armed', shouldRemount: false };
    }
    // onStop settled — row may or may not already be enabled.
    if (disabled) {
      return { phase: 'settled', shouldRemount: false };
    }
    // Row already enabled after stop completed — remount immediately.
    // This is the missed-react-transition fix: React never committed
    // disabled=true, so we remount when the first enabled frame arrives
    // after onStop settled.
    return { phase: 'idle', shouldRemount: true };
  }

  // phase === 'settled'
  if (disabled) {
    return { phase: 'settled', shouldRemount: false };
  }

  return { phase: 'idle', shouldRemount: true };
}
