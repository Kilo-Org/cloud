/**
 * How long a Back still belongs to a screen that is leaving.
 *
 * A save that dismisses its own screen and a Back that leaves it are the same
 * leave, and they can overlap in either order: the save resolves while the
 * Back's pop is still being applied, or the Back arrives while the save's own
 * dismissal animates out. The exit animation was measured at 575-620 ms on the
 * Android emulator, so a press inside this span was pressed at the screen that
 * is leaving — often before the route was removed, and always before the reader
 * could have read the screen beneath. The span is bounded rather than latched,
 * so a press that never actually left the screen cannot block a later save.
 */
export const LEAVE_SETTLE_MS = 700;

/**
 * When a screen last dismissed itself, or `0` for none yet.
 *
 * It lives here rather than in the dismissing screen because that screen is
 * unmounted before a late Back is dispatched: the window has to outlive the
 * route whose leave it describes.
 */
let dismissedAt = 0;

/** When a screen last accepted a Back. Bounded the same way. */
let backAt = 0;

/** How well `now` sits inside a window opened at `mark`. */
function insideWindow(mark: number, now: number): boolean {
  // A wall clock can step backwards (NTP correction, a manual change), which
  // makes the delta negative. That is a clock step, not an event inside the
  // window, so it opens nothing.
  const elapsed = now - mark;
  return elapsed >= 0 && elapsed < LEAVE_SETTLE_MS;
}

/** Record that a screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(now: number): void {
  dismissedAt = now;
}

/** Whether this Back was already answered by a screen that dismissed itself. */
export function insideLeaveSettle(now: number): boolean {
  return insideWindow(dismissedAt, now);
}

/** Record that a screen accepted a Back, so its own save must not also pop. */
export function noteAcceptedBack(now: number): void {
  backAt = now;
}

/** Whether a Back that pops this screen is still being applied. */
export function backInFlight(now: number): boolean {
  return insideWindow(backAt, now);
}

/** Drop both windows, for tests that assert from a known state. */
export function resetLeaveSettle(): void {
  dismissedAt = 0;
  backAt = 0;
}
