/**
 * The once-per-process marker for the tour's automatic open.
 *
 * Module state is evaluated once per JS process, i.e. once per cold boot. A
 * warm entry into the `(app)` area or a foreground resume re-renders the gate
 * without re-evaluating this module, so it can never re-arm the automatic
 * open. Spending the marker is one-way: nothing clears it, and a manual open
 * from Profile must not spend it for a later launch.
 */
let attemptSpent = false;

/** Whether this process has already used its one automatic open attempt. */
export function isTourAutoOpenAttemptSpent(): boolean {
  return attemptSpent;
}

/** Marks the automatic open attempt as used for the rest of this process. */
export function spendTourAutoOpenAttempt(): void {
  attemptSpent = true;
}
