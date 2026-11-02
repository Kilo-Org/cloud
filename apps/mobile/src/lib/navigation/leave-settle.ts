/**
 * How long a Back still belongs to a screen that dismissed itself.
 *
 * When a screen pops itself because its save confirmed, the route leaves the
 * navigator while its exit animation runs; the animation was measured at
 * 575-620 ms on the Android emulator. A Back that reaches the app inside that
 * span was pressed at the screen that is leaving — often before the route was
 * removed, and always before the reader could have read the screen beneath — so
 * the app must not spend it on that screen beneath. Once the window closes the
 * next Back behaves normally.
 */
export const LEAVE_SETTLE_MS = 700;

/**
 * When a screen last dismissed itself, or `0` for none yet.
 *
 * It lives here rather than in the dismissing screen because that screen is
 * unmounted before the Back is dispatched: the window has to outlive the route
 * whose leave it describes.
 */
let settledAt = 0;

/** Record that a screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(now: number): void {
  settledAt = now;
}

/**
 * Whether a Back received at `now` belongs to a screen that already dismissed
 * itself.
 *
 * A wall clock can step backwards (NTP correction, a manual change), which
 * makes the delta negative. That is a clock step, not a Back from inside the
 * window, so it opens nothing and lets the Back through.
 */
export function insideLeaveSettle(now: number): boolean {
  const elapsed = now - settledAt;
  return elapsed >= 0 && elapsed < LEAVE_SETTLE_MS;
}

/** Drop the window, for tests that assert from a known state. */
export function resetLeaveSettle(): void {
  settledAt = 0;
}