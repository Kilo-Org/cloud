/**
 * The app's own privacy lock, as the App Intents catalog sees it.
 *
 * Two readers, neither a React component: the catalog publish checks the gate
 * immediately before it writes, and the launch clear runs from the one place
 * that observes the status. A module-level value is what lets both work without
 * a render. It carries no imports on purpose — the unlock provider is above
 * everything, and every module it reached would load the native bridge and the
 * whole Expo runtime into the provider's own tests.
 *
 * The value is the provider's status, not a boolean, because "not yet known" is
 * a third state: `AppUnlockScene` hides the tree for every status except
 * `'unlocked'`, so a launch that is still reading the preference is showing the
 * lock surface. Treating that as unlocked is exactly how a catalog persisted by
 * the previous process stays readable for the length of the keychain read.
 */
export type AppLockStatus = 'preference-loading' | 'locked' | 'unlocked';

let status: AppLockStatus = 'preference-loading';

/** Whether the app is known to be unlocked, which is the only state that publishes. */
export function isCatalogPublishAllowed(): boolean {
  return status === 'unlocked';
}

/**
 * Publishes the provider's status.
 *
 * A value other than `'unlocked'` closes the gate: the publish refuses, and the
 * caller wipes what the previous status left readable.
 */
export function setAppLockStatus(next: AppLockStatus): void {
  status = next;
}
