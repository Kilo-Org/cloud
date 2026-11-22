// The sign-out teardown guard: set synchronously when an auth transition
// (sign-out or sign-in) starts and cleared only when a sign-in publishes its
// credentials. While it is set the stored credentials are scheduled for
// deletion, so a refresh must not read or publish them and a request-token
// cold read must not warm the owner from them. The in-memory owner keeps
// serving while the guard is set: sign-out's remote cleanup still needs its
// auth headers until the epoch bump.
//
// Its own module so consumers that must stay free of the credential machinery
// (the telemetry-adjacent blocked-account raise, the pure test projects) can
// read the window without pulling the SecureStore stack. `token-owner.ts`
// re-exports it as the single source.

let signOutTeardownActive = false;

/** Marks the sign-out teardown window (set at transition start, cleared at a sign-in's publish). */
export function setSignOutTeardownActive(active: boolean): void {
  signOutTeardownActive = active;
}

export function isSignOutTeardownActive(): boolean {
  return signOutTeardownActive;
}
