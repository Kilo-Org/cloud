// The one "this account is blocked" explanation for the whole app. Raised by
// the two places that learn it — the refresh route's `USER_BLOCKED` refusal and
// the current-user read's `accountBlocked` refusal — and cleared only when a
// sign-in publishes new credentials.
//
// The flag deliberately outlives sign-out: the sign-out a blocked refusal
// triggers tears down the credential, not the reason, so the explanation the
// person needs (their access was restricted, and where to ask about it) stays
// on screen after the session it belonged to is gone. A successful sign-in is
// the one event that proves the block no longer applies, so it clears the flag.

let blockedAccountActive = false;
const listeners = new Set<() => void>();

/** True while the signed-out surface must explain a blocked account. */
export function isBlockedAccountActive(): boolean {
  return blockedAccountActive;
}

/** Marks the blocked explanation as active or cleared, and notifies React subscribers. */
export function setBlockedAccountActive(active: boolean): void {
  if (blockedAccountActive === active) {
    return;
  }
  blockedAccountActive = active;
  for (const listener of listeners) {
    listener();
  }
}

/** `useSyncExternalStore` subscribe for {@link isBlockedAccountActive}. */
export function subscribeBlockedAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
