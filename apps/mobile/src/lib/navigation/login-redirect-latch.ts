/**
 * The one-dispatch latch for the sign-out login redirect.
 *
 * The bootstrap decision reads `useSegments()`, which only updates after the
 * router commits a navigation. A sign-out clears the token, so every decision
 * before that commit reports `redirect-login` while the segments still name the
 * group being left. Dispatching each one replaces the login route again — it
 * unmounts and remounts, and the reader sees the destination arrive twice.
 *
 * The latch is set by the dispatch and released by the first decision that is
 * neither `redirect-login` nor a wait: a settle means the tree arrived, and
 * another redirect means a different destination was dispatched, so the pending
 * login redirect is no longer outstanding. A wait holds it — the tree has
 * settled nowhere yet, and a release there would let the following
 * `redirect-login` replace login a second time.
 *
 * A navigator that is not ready neither dispatches nor sets the latch, so the
 * effect's rerun when readiness flips still dispatches.
 *
 * Only the login target is latched: the other redirects of the same decision
 * (consent, app, force-update) are dispatched by the caller exactly as before.
 */
import { type BootstrapDecision } from '@/lib/bootstrap-decision';

export type LoginRedirectDecision = 'login' | 'wait' | 'other';

export type LoginRedirectLatch = {
  /**
   * Whether this decision should dispatch the login redirect. Every decision
   * has to pass through here, because leaving `redirect-login` is what
   * releases the latch.
   */
  shouldDispatch(input: {
    readonly decision: LoginRedirectDecision;
    readonly navigationReady: boolean;
  }): boolean;
};

/** Classify a bootstrap tag: the login redirect, a wait, or any settled route. */
export function loginRedirectDecision(tag: BootstrapDecision['tag']): LoginRedirectDecision {
  if (tag === 'redirect-login') {
    return 'login';
  }
  return tag.startsWith('wait-') ? 'wait' : 'other';
}

export function createLoginRedirectLatch(): LoginRedirectLatch {
  let dispatched = false;

  return {
    shouldDispatch({ decision, navigationReady }) {
      if (decision === 'wait') {
        return false;
      }
      if (decision === 'other') {
        dispatched = false;
        return false;
      }
      if (dispatched || !navigationReady) {
        return false;
      }
      dispatched = true;
      return true;
    },
  };
}
