/**
 * How long a Back still belongs to a screen that is leaving.
 *
 * A save that dismisses its own screen and a Back that leaves it are the same
 * leave, and they can overlap in either order. Two spans, measured separately,
 * cover the pair:
 *
 * - A Back this route accepts takes 276-295 ms to make the route report itself
 *   unfocused (measured on the Android emulator, three presses). Until then the
 *   navigator has not committed the pop, so a save resolving in that span must
 *   not dispatch a second one.
 * - The dismissing route stays mounted for its exit animation, measured at
 *   575-620 ms, so a Back pressed inside that animation was pressed at the
 *   screen that is leaving and must not reach the screen beneath.
 *
 * Both spans are bounded rather than latched, so a press that never actually
 * left the screen cannot suppress a later dismissal. The Back span is kept
 * shorter than any human answer to a confirmation, so a Back that a guard
 * intercepts and the reader cancels cannot outlast the prompt.
 */
export const BACK_COMMIT_MS = 400;

/** How long a dismissed screen keeps its Back, from the exit-animation measurement. */
export const LEAVE_SETTLE_MS = 700;

/**
 * When a screen last dismissed itself, or `0` for none yet.
 *
 * It lives here rather than in the dismissing screen because that screen is
 * unmounted before a late Back is dispatched: the window has to outlive the
 * route whose leave it describes.
 */
let dismissedAt = 0;

/** How well `now` sits inside a window opened at `mark`. */
export function insideWindow(mark: number, now: number, span: number): boolean {
  // A wall clock can step backwards (NTP correction, a manual change), which
  // makes the delta negative. That is a clock step, not an event inside the
  // window, so it opens nothing.
  const elapsed = now - mark;
  return elapsed >= 0 && elapsed < span;
}

/** Record that a screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(now: number): void {
  dismissedAt = now;
}

/** Whether this Back was already answered by a screen that dismissed itself. */
export function insideLeaveSettle(now: number): boolean {
  return insideWindow(dismissedAt, now, LEAVE_SETTLE_MS);
}

/** Drop the window, for tests that assert from a known state. */
export function resetLeaveSettle(): void {
  dismissedAt = 0;
}
