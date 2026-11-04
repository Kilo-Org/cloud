/**
 * Whether `now` falls inside the burst window opened at `openedAt`.
 *
 * Both single-navigation guards use this: one header Back press and one push to
 * a destination each start a window, and a second press of the same kind inside
 * it belongs to the same gesture.
 *
 * A wall clock can step backwards (NTP correction, a manual change), which
 * makes the delta negative and would keep every press out for as long as the
 * step lasts. A negative delta is read as "the clock moved, not a repeat" and
 * opens a fresh window instead.
 */
export function insideBurstWindow(openedAt: number, now: number, windowMs: number): boolean {
  const elapsed = now - openedAt;
  return elapsed >= 0 && elapsed < windowMs;
}
