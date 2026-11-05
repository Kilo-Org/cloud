/**
 * Whether the app's own privacy lock is covering the screen.
 *
 * A module-level flag rather than a hook, because one reader is not a React
 * component: the App Intents catalog publish checks it immediately before it
 * writes, and a component's state cannot be read from there. It carries no
 * imports on purpose — the auth provider imports this module, and every module
 * it reached would load the native bridge and the whole Expo runtime into the
 * provider's own tests.
 */
let locked = false;

export function isAppLocked(): boolean {
  return locked;
}

/**
 * Publishes the lock state. `AppUnlockProvider` is the only source of truth,
 * and its consumer inside the signed-in group (`SystemSearchIndexMount`) is the
 * one writer: it also wipes the catalog on the lock, so the flag and the wipe
 * cannot drift apart.
 */
export function setAppLocked(value: boolean): void {
  locked = value;
}
