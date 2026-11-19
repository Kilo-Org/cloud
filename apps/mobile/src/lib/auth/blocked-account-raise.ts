// The shared raise path for a blocked-account refusal, alongside the state
// store. The current-user read raises through `account-blocked-read.ts`, which
// owns the reveal and the refetch-on-answer transition; every OTHER procedure
// that answers with the refusal only learns "this account is blocked" — the
// identity read may not refetch for its own 30 s freshness window, so without
// this path a mid-session block first shows a generic error on whatever surface
// the person touched.
//
// The same fences as the read hook apply: no raise during a sign-out teardown
// (an attempt that settles while Sign out runs must not re-raise the
// explanation over the login route), and a raise never publishes over an
// already-raised state (the identity read owns the clear).

import { isBlockedAccountActive, setBlockedAccountActive } from '@/lib/auth/blocked-account-state';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { isAccountBlockedTrpcError } from '@/lib/trpc-error';

/**
 * Raises the blocked-account explanation from any procedure's refusal. Total:
 * never throws, and a refusal that arrives during a sign-out teardown, with no
 * session to explain, or for an already-raised state changes nothing — the
 * identity read's hook owns those transitions.
 */
export function raiseBlockedAccountFromRefusal(error: unknown): void {
  if (!isAccountBlockedTrpcError(error)) {
    return;
  }
  if (isSignOutActive() || isBlockedAccountActive()) {
    return;
  }
  setBlockedAccountActive(true);
}
