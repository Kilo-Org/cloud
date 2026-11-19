// The shared raise path for a blocked-account refusal, alongside the state
// store. The current-user read raises through `account-blocked-read.ts`, which
// owns the reveal and the refetch-on-answer transition; every OTHER procedure
// that answers with the refusal only learns "this account is blocked" — the
// identity read may not refetch for its own 30 s freshness window, so without
// this path a mid-session block first shows a generic error on whatever surface
// the person touched.
//
// The fences match the read hook's and one more: no raise while an auth
// transition owns the credentials (`isSignOutActive`, and the teardown guard
// that also covers the sign-in window between its start and its credential
// publication — a refusal from the previous session settling in that window
// must not raise an explanation for the account just signed in), and a raise
// never publishes over an already-raised state (the identity read owns the
// clear).

import { isBlockedAccountActive, setBlockedAccountActive } from '@/lib/auth/blocked-account-state';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { isSignOutTeardownActive } from '@/lib/auth/auth-transition-state';
import { isAccountBlockedTrpcError } from '@/lib/trpc-error';

/**
 * Raises the blocked-account explanation from any procedure's refusal. Total:
 * never throws, and a refusal that arrives during an auth transition (sign-out
 * teardown, or the sign-in window before its credentials publish), or for an
 * already-raised state, changes nothing — the identity read's hook owns the
 * clear.
 */
export function raiseBlockedAccountFromRefusal(error: unknown): void {
  if (!isAccountBlockedTrpcError(error)) {
    return;
  }
  if (isSignOutActive() || isSignOutTeardownActive() || isBlockedAccountActive()) {
    return;
  }
  setBlockedAccountActive(true);
}
