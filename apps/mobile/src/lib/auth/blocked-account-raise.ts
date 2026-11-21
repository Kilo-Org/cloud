// The shared raise path for a blocked-account refusal, alongside the state
// store. The current-user read raises through `account-blocked-read.ts`, which
// owns the reveal and the refetch-on-answer transition; every OTHER procedure
// that answers with the refusal only learns "this account is blocked" — the
// identity read may not refetch for its own 30 s freshness window, so without
// this path a mid-session block first shows a generic error on whatever surface
// the person touched.
//
// The raise requires both that no auth transition owns the credentials and that
// the refusal belongs to the session the app is now serving. The fences cover
// the transition windows (`isSignOutActive`, and the teardown guard that also
// covers the sign-in window between its start and its credential publication),
// a raise never publishes over an already-raised state (the identity read owns
// the clear), and `isFromCurrentDispatchSession` covers the case the booleans
// cannot: a refusal dispatched by the previous session that settles AFTER a new
// sign-in cleared every boolean fence. Only the auth epoch names the session
// that issued the call, so a refusal from an earlier epoch never raises an
// explanation over the account just signed in.

import {
  isBlockedAccountActive,
  setBlockedAccountExplanation,
} from '@/lib/auth/blocked-account-state';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { isSignOutTeardownActive } from '@/lib/auth/auth-transition-state';
import { isFromCurrentDispatchSession } from '@/lib/auth/dispatch-epoch';
import { isAccountBlockedTrpcError, readAccountBlockedReason } from '@/lib/trpc-error';

/**
 * Raises the blocked-account explanation from any procedure's refusal. Total:
 * never throws, and a refusal that arrives during an auth transition (sign-out
 * teardown, or the sign-in window before its credentials publish), that was
 * dispatched by an earlier auth session, or for an already-raised state, changes
 * nothing — the identity read's hook owns the clear.
 */
export function raiseBlockedAccountFromRefusal(error: unknown): void {
  if (!isAccountBlockedTrpcError(error)) {
    return;
  }
  if (isSignOutActive() || isSignOutTeardownActive() || isBlockedAccountActive()) {
    return;
  }
  // A refusal dispatched by the previous session can settle after a new sign-in
  // opened every boolean fence above; the dispatch epoch is what still names the
  // session that issued the call.
  if (!isFromCurrentDispatchSession(error)) {
    return;
  }
  setBlockedAccountExplanation(readAccountBlockedReason(error) ?? 'account_blocked');
}
