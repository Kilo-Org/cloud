/**
 * How long a dismissed screen keeps its Back.
 *
 * A screen that pops itself because its save confirmed stays mounted for its
 * exit animation, measured at 575-620 ms on the Android emulator, and a Back
 * pressed inside that animation was pressed at the screen that is leaving. The
 * span is bounded rather than latched, so nothing outlives the leave it
 * describes; a press after it behaves as any other Back.
 */
export const LEAVE_SETTLE_MS = 700;

/**
 * When a screen dismissed itself, or `0` for none yet.
 *
 * It lives here rather than in the dismissing screen because that screen is
 * unmounted before a late Back is dispatched: the window has to outlive the
 * route whose leave it describes.
 */
let dismissedAt = 0;

/**
 * A Back a screen accepted and the navigator has not acted on yet.
 *
 * It is keyed by the route that accepted it so one screen's in-flight Back can
 * never suppress another screen's dismissal, and it ends on the event that
 * settles it — the route blurring, or leaving without blurring — rather than on
 * a clock, so a slow device only lengthens the interval it covers.
 */
let acceptedBack: Readonly<{ routeId: string; at: number }> | null = null;

/** Whether `now` falls inside the span opened at `mark`. */
function insideWindow(mark: number, now: number, span: number): boolean {
  // A wall clock can step backwards (NTP correction, a manual change), which
  // makes the delta negative. That is a clock step, not an event inside the
  // window, so it opens nothing.
  const elapsed = now - mark;
  return elapsed >= 0 && elapsed < span;
}

/** Record that this screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(now: number): void {
  dismissedAt = now;
}

/** Whether a Back was already answered by a screen that dismissed itself. */
export function insideLeaveSettle(now: number): boolean {
  return insideWindow(dismissedAt, now, LEAVE_SETTLE_MS);
}

/** Record a Back the route `routeId` accepted and the navigator has not applied. */
export function noteAcceptedBack(routeId: string, now: number): void {
  acceptedBack = { routeId, at: now };
}

/**
 * Forget the accepted Back: the navigator applied it, the route left, or the
 * reader cancelled the leave.
 *
 * A caller that knows which route it speaks for passes its id, so clearing the
 * mark cannot silently drop another route's in-flight Back.
 */
export function clearAcceptedBack(routeId?: string): void {
  if (routeId === undefined || acceptedBack?.routeId === routeId) {
    acceptedBack = null;
  }
}

/** Whether a Back the route `routeId` accepted is still being applied. */
export function backAcceptedBy(routeId: string): boolean {
  return acceptedBack?.routeId === routeId;
}

/** Drop both marks, for tests that assert from a known state. */
export function resetLeaveSettle(): void {
  dismissedAt = 0;
  acceptedBack = null;
}
