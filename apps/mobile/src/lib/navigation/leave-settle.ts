/**
 * The marks that make one Back close one screen.
 *
 * A screen that pops itself after its save confirmed leaves an exit animation
 * behind it; a screen that accepted a Back leaves the navigator applying that
 * press behind it. Each mark ends on the event that settles it, never on a
 * wall clock, because only the platform knows how long its own transition or a
 * loaded JavaScript thread takes.
 */

/**
 * Whether a screen that dismissed itself is still animating away.
 *
 * It lives here rather than in the dismissing screen because that screen is
 * unmounted before a late Back is dispatched: the window has to outlive the
 * route whose leave it describes.
 *
 * The scene the dismissal revealed ends it when its own appearance transition
 * ends — that transition is the one that carried the dismissing screen away, so
 * its end is the end of that leave. Until then the app shell answers a Back
 * (`LeaveSettleMount`); if that scene's transition end never arrives, the
 * shell's own spend ends the window, so a dismissal holds at most one press
 * instead of every later one.
 */
let dismissing = false;

/**
 * A Back a screen accepted and the navigator has not acted on yet.
 *
 * It is keyed by the route that accepted it so one screen's in-flight Back can
 * never suppress another screen's dismissal, and it ends on the event that
 * settles it — the route blurring, or leaving without blurring.
 */
let acceptedBack: string | null = null;

/** Record that this screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(): void {
  dismissing = true;
}

/** End the settle window: the leave's transition finished, or the shell spent its press. */
export function endLeaveSettle(): void {
  dismissing = false;
}

/** Whether a Back was already answered by a screen that dismissed itself. */
export function insideLeaveSettle(): boolean {
  return dismissing;
}

/** Record a Back the route `routeId` accepted and the navigator has not applied. */
export function noteAcceptedBack(routeId: string): void {
  acceptedBack = routeId;
}

/**
 * Forget the accepted Back: the navigator applied it, the route left, or the
 * reader cancelled the leave.
 *
 * A caller that knows which route it speaks for passes its id, so clearing the
 * mark cannot silently drop another route's in-flight Back.
 */
export function clearAcceptedBack(routeId?: string): void {
  if (routeId === undefined || acceptedBack === routeId) {
    acceptedBack = null;
  }
}

/** Whether a Back the route `routeId` accepted is still being applied. */
export function backAcceptedBy(routeId: string): boolean {
  return acceptedBack === routeId;
}

/** Drop both marks, for tests that assert from a known state. */
export function resetLeaveSettle(): void {
  dismissing = false;
  acceptedBack = null;
}
