/**
 * Burst window for one header Back press.
 *
 * Presses that reach a header inside one burst belong to the same gesture, and
 * each one dispatches its own `router.back()` — expo-router enqueues one
 * `GO_BACK` per call and the queue drains in order. On the Android emulator a
 * four-tap burst on the Security Agent settings header delivered two presses to
 * the same header 4 ms apart, so one gesture popped two screens. The window can
 * be generous because the screen a dispatched back pops takes its guard with it,
 * so the next screen's press starts a fresh window.
 */
export const HEADER_BACK_GUARD_MS = 500;

/** Mutable guard state. Each header keeps one instance in a ref. */
export type HeaderBackGuardState = {
  /** `Date.now()` of the last dispatched back. `0` means none yet. */
  lastBackAt: number;
};

/**
 * Whether `now` is inside the window opened at `lastBackAt`.
 *
 * A wall clock can step backwards (NTP correction, a manual change), which
 * makes the delta negative and would keep every press out for as long as the
 * step lasts. A negative delta is read as "the clock moved, not a repeat" and
 * opens a fresh window instead.
 */
function insideWindow(lastBackAt: number, now: number): boolean {
  const elapsed = now - lastBackAt;
  return elapsed >= 0 && elapsed < HEADER_BACK_GUARD_MS;
}

/** What a header Back press should run. */
type HeaderBackDecision = 'handler' | 'history' | 'fallback' | 'none';

/**
 * Claim the burst window: `true` when this press may dispatch, `false` when it
 * repeats a dispatch inside the window. The accepted press is recorded before
 * returning, so a re-entrant call cannot claim the same window twice.
 */
export function claimHeaderBack(state: HeaderBackGuardState, now: number): boolean {
  if (insideWindow(state.lastBackAt, now)) {
    return false;
  }
  state.lastBackAt = now;
  return true;
}

/**
 * Decide what a Back press runs, from the controls the screen declared.
 *
 * A screen's own `onBack` owns the press, because it may open a confirmation
 * instead of popping. Otherwise the navigator pops only when it has somewhere
 * to pop to: a `router.back()` with no history is handled by
 * whatever navigator is left (the tab navigator switches to its first tab) or
 * is unhandled at the root, which is the unwinding past the stack root this
 * guard exists to stop. A declared `backFallback` is the destination for a
 * screen reached without history; with neither, the press does nothing.
 */
export function resolveHeaderBack(declared: {
  hasHandler: boolean;
  hasFallback: boolean;
  canGoBack: boolean;
}): HeaderBackDecision {
  if (declared.hasHandler) {
    return 'handler';
  }
  if (declared.canGoBack) {
    return 'history';
  }
  return declared.hasFallback ? 'fallback' : 'none';
}
