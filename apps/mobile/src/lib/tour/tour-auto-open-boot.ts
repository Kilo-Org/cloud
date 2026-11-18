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
let attemptUserId: string | null = null;

/** Whether this process has already used its one automatic open attempt. */
export function isTourAutoOpenAttemptSpent(): boolean {
  return attemptSpent;
}

/** Marks the automatic open attempt as used for the rest of this process. */
export function spendTourAutoOpenAttempt(): void {
  attemptSpent = true;
}

/**
 * Binds the process's one automatic attempt to the first account the gate sees
 * after a cold boot, and reports whether the attempt belongs to `userId`.
 *
 * The binding lives in module state rather than a component ref so it survives
 * a remount of the `(app)` tree: a sign-out unmounts the gate while the
 * process-wide attempt survives, so a different account signing in later in the
 * same process is not the launch account and cannot inherit the attempt.
 */
export function claimTourAutoOpenAttempt(userId: string): boolean {
  if (attemptUserId === null) {
    attemptUserId = userId;
    return true;
  }
  return attemptUserId === userId;
}
