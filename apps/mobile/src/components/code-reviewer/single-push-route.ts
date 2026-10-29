/**
 * Guard window for one code reviewer navigation. Two presses inside this window
 * belong to the same burst, and the second would push the destination route
 * again, so the reader would need two Back presses to return. The window can be
 * generous because the guard also clears when the screen regains focus, so a
 * press right after a return is never dropped.
 */
export const CODE_REVIEWER_PUSH_GUARD_MS = 1000;

/** Mutable guard state. Each screen keeps one instance in a ref. */
export type SinglePushGuardState = {
  /** `Date.now()` of the last accepted push. `0` means no push yet. */
  lastPushAt: number;
};

/**
 * Claim the single-push window: `true` when the caller may push, `false` when
 * this call is the second press of a burst. Writes `lastPushAt` before
 * returning, so a re-entrant call cannot claim the same window twice.
 */
export function claimSinglePush(state: SinglePushGuardState, now: number): boolean {
  if (now - state.lastPushAt < CODE_REVIEWER_PUSH_GUARD_MS) {
    return false;
  }
  state.lastPushAt = now;
  return true;
}
