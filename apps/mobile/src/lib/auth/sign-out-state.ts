// The one "a sign-out is in progress" flag for the whole app. Set
// synchronously at the start of sign-out (before any await) and cleared only
// after a sign-in's credential publication succeeds.
//
// Two consumers read this single flag, so a new sign-out path cannot set one
// and forget the other:
//   - the read-cache publication fence (`createReadCachePersister`), which
//     refuses a cache write while sign-out is clearing the scope;
//   - the auth context's `isSigningOut`, subscribed through
//     `useSyncExternalStore`, which stops the cache mount from resubscribing.

let signOutActive = false;
const listeners = new Set<() => void>();

/** True while sign-out teardown is in progress or the user is signed out. */
export function isSignOutActive(): boolean {
  return signOutActive;
}

/** Marks sign-out as active or cleared, and notifies React subscribers. */
export function setSignOutActive(active: boolean): void {
  if (signOutActive === active) {
    return;
  }
  signOutActive = active;
  for (const listener of listeners) {
    listener();
  }
}

/** `useSyncExternalStore` subscribe for {@link isSignOutActive}. */
export function subscribeSignOutActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
