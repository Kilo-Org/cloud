/**
 * The marks that make one Back close one screen.
 *
 * A screen that pops itself after its save confirmed leaves an exit animation
 * behind it; a screen that accepted a Back leaves the navigator applying that
 * press behind it. Each mark ends on the event that settles it, because only
 * the platform knows how long its own transition or a loaded JavaScript thread
 * takes. The dismissal's window also carries a backstop, and a deliberately
 * long one: it only bounds a missing event, it never decides who a press
 * belongs to.
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
 * (`LeaveSettleMount`). That shell listener sees Android's hardware Back only,
 * so a missed transition end needs a platform-independent bound: the backstop
 * below clears the window long after any leave could still be running, which
 * costs nothing on the normal path because the event clears it first.
 */
let dismissing = false;

/**
 * How long a missed transition end may keep the window open.
 *
 * This is not the attribution window: the revealed scene's transition ends
 * that, measured at 1.0-1.1 s after the dismissal on the Android emulator with
 * the commit latency included. The backstop only bounds a latch that would
 * otherwise survive on a platform where the shell's hardware-Back listener
 * never runs, so it is set well past any observed leave.
 */
export const LEAVE_SETTLE_BACKSTOP_MS = 5_000;

let backstop: ReturnType<typeof setTimeout> | undefined = undefined;

/** Record that this screen is dismissing itself for its own reason, not a Back. */
export function armLeaveSettle(): void {
  dismissing = true;
  clearTimeout(backstop);
  backstop = setTimeout(() => {
    dismissing = false;
  }, LEAVE_SETTLE_BACKSTOP_MS);
}

/** End the settle window: the leave's transition finished, or the shell spent its press. */
export function endLeaveSettle(): void {
  dismissing = false;
  clearTimeout(backstop);
  backstop = undefined;
}

/**
 * A Back a screen accepted and the navigator has not acted on yet.
 *
 * It is keyed by the route that accepted it so one screen's in-flight Back can
 * never suppress another screen's dismissal, and it ends on the event that
 * settles it — the route blurring, or leaving without blurring.
 */
let acceptedBack: string | null = null;

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
  endLeaveSettle();
  acceptedBack = null;
}
