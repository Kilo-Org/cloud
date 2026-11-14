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
 *
 * The dismissal's window ends in two steps. The revealed scene's appearance
 * transition is the one that carried the dismissing screen away, so its end is
 * the trustworthy end of that leave. A short grace then follows, because a
 * reader who is still acting on the screen that went presses Back a moment
 * after it left, and that press still belongs to the leave.
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
 * below ends the window long after any leave could still be running, which
 * costs nothing on the normal path because the event clears it first.
 */
let dismissing = false;

/**
 * When the grace after the animation ends; `0` while no grace is open.
 *
 * An instant rather than a flag, so the grace needs no timer of its own: the
 * reader's own press is the only event that can arrive inside it.
 */
let graceUntil = 0;

/**
 * How long a press still belongs to the leave after its animation ended.
 *
 * A transition end is the end of the animation, not of the reader's action on
 * the screen that went: a press the reader already aimed at that screen arrives
 * a moment later, and the screen beneath must not take it. This span covers
 * that press. A deliberate press after it is a press on the screen now shown,
 * and it works.
 */
export const LEAVE_SETTLE_GRACE_MS = 500;

/**
 * How long a missed transition end may keep the window open.
 *
 * This is not the attribution window: the revealed scene's transition ends
 * that, measured at 1.0-1.1 s after the dismissal on the Android emulator with
 * the commit latency included. The backstop only bounds a latch that would
 * otherwise survive on a platform where the shell's hardware-Back listener
 * never runs, so it is set well past any observed leave.
 *
 * When it fires it closes the window without opening a grace: a leave whose
 * animation never reported its end has no trustworthy end to cover a press
 * after.
 */
export const LEAVE_SETTLE_BACKSTOP_MS = 5_000;

let backstop: ReturnType<typeof setTimeout> | undefined = undefined;

/** Drop the backstop timer: an event decided the window before it fired. */
function clearBackstop(): void {
  clearTimeout(backstop);
  backstop = undefined;
}

/**
 * Record that this screen is dismissing itself for its own reason, not a Back.
 *
 * A new dismissal closes any grace still open: the press that grace covered
 * belonged to the leave that just ended.
 */
export function armLeaveSettle(): void {
  dismissing = true;
  graceUntil = 0;
  clearBackstop();
  backstop = setTimeout(endLeaveSettle, LEAVE_SETTLE_BACKSTOP_MS);
}

/**
 * End the leave's animation and open the grace that follows it.
 *
 * The revealed scene's transition end calls this. Every scene reports its own
 * appearance transition on every push and tab switch, so this does nothing
 * unless this app opened a leave window: a press after an ordinary push belongs
 * to the screen that push revealed.
 */
export function settleLeaveWindow(): void {
  if (!dismissing) {
    return;
  }
  dismissing = false;
  graceUntil = Date.now() + LEAVE_SETTLE_GRACE_MS;
  clearBackstop();
}

/**
 * Close the window and its grace at once.
 *
 * The shell calls this when it spends a press, and `resetLeaveSettle` calls it
 * for tests that assert from a known state.
 */
export function endLeaveSettle(): void {
  dismissing = false;
  graceUntil = 0;
  clearBackstop();
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

/**
 * Whether a press now belongs to a leave.
 *
 * True while that leave animates, and true through the grace that follows its
 * animation: in both the press means the screen that left, not the screen the
 * leave revealed.
 */
export function spendsLeaveBackPress(): boolean {
  return dismissing || (graceUntil !== 0 && Date.now() < graceUntil);
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
