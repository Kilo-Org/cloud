// The one "this account is blocked" explanation for the whole app, held as the
// refusal reason rather than a flag: the presence and the reason always change
// together, and the reason is what picks the actions the surface offers.
//
// Three states:
//
// - `'account_blocked'`: the account itself is blocked. Support can lift it, so
//   a re-read over the session that was refused can succeed (`Retry`).
// - `'email_domain_blocked'`: the account's email domain is on the admin
//   blacklist. No retry, sign-out or sign-in changes it, so the surface offers
//   no Retry at all.
// - `null`: nothing raised, so no surface.
//
// Raised by the two places that learn it — the refresh route's `USER_BLOCKED`
// refusal and any procedure's `accountBlocked` refusal. Cleared by the answered
// current-user read that follows a raise this app made (an attempt that reaches
// the account proves the block lifted — `account-blocked-read.ts`), the blocked
// surface's own exit, and a successful sign-in.
//
// The explanation deliberately outlives a sign-out the refusal triggered: that
// teardown removes the credential, not the reason, so the explanation the person
// needs (their access was restricted, and where to ask about it) stays on screen
// after the session it belonged to is gone.

import { type AccountBlockedRefusalReason } from '@kilocode/app-shared/auth';

let blockedAccountExplanation: AccountBlockedRefusalReason | null = null;
const listeners = new Set<() => void>();

/** The raised refusal reason, or null while no explanation is on screen. */
export function getBlockedAccountExplanation(): AccountBlockedRefusalReason | null {
  return blockedAccountExplanation;
}

/** True while the signed-out surface must explain a blocked account. */
export function isBlockedAccountActive(): boolean {
  return blockedAccountExplanation !== null;
}

/** Sets the raised refusal reason (null clears it) and notifies React subscribers. */
export function setBlockedAccountExplanation(
  explanation: AccountBlockedRefusalReason | null
): void {
  if (blockedAccountExplanation === explanation) {
    return;
  }
  blockedAccountExplanation = explanation;
  for (const listener of listeners) {
    listener();
  }
}

/** `useSyncExternalStore` subscribe for {@link getBlockedAccountExplanation}. */
export function subscribeBlockedAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
