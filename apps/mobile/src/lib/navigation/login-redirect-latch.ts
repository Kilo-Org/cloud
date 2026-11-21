/**
 * The login redirect a sign-out already dispatched and has not yet seen land.
 *
 * The bootstrap decision reads `useSegments()`, which only updates after the
 * router commits a navigation. A sign-out clears the token, so every render
 * before that commit re-emits `redirect-login` while the segments still name
 * the group being left. Dispatching each one replaces the login route a second
 * time — it unmounts and remounts, and the reader sees the destination arrive
 * twice.
 *
 * Only the login target is gated: the other redirects of the same decision
 * (consent, app, force-update) keep their existing behaviour.
 *
 * `LOGIN_REDIRECT_RETRY_MS` is the bound. A replace the router dropped would
 * otherwise strand the person on the screen the sign-out just left, so the
 * destination is dispatched again once that long has passed without the tree
 * settling. The latch is cleared whenever the decision settles, so the next
 * sign-out dispatches login afresh.
 */
export const LOGIN_REDIRECT_RETRY_MS = 1000;

export type LoginRedirectLatch = { readonly dispatchedAt: number };

export function shouldDispatchLoginRedirect(
  latch: LoginRedirectLatch | null,
  now: number
): boolean {
  if (latch === null) {
    return true;
  }
  return now - latch.dispatchedAt >= LOGIN_REDIRECT_RETRY_MS;
}
