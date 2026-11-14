/**
 * Whether iOS data protection currently lets the app read the keychain.
 *
 * The credential items — the bearer tokens and the session hints — use a
 * `WHEN_UNLOCKED*` accessibility, so while the device is locked (or not yet
 * unlocked after a reboot) the keychain refuses each call with
 * `errSecInteractionNotAllowed`. A push, a background task or a resumed timer
 * can run JS in that state. A refused call there is not a defect and not an
 * unreadable session: the credential gates in `lib/auth/secure-store*` skip the
 * call, the telemetry does not file it, and the startup restore and the
 * encrypted database open wait for unlock.
 *
 * The widget and glanceable scope items are the exception: they are written
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (`lib/glanceable/widget-store`), so a
 * background push must reach them with the screen locked. `secure-store-gated`
 * attempts those calls instead of skipping them, and this state only separates
 * a refusal before the device's first unlock since boot from a real failure.
 *
 * Pure and native-free, so the suites that load the keychain helpers need no
 * native module. `protected-data-native.ts` feeds the iOS state in from the
 * app entry. Without a source (Android, tests) the data stays available.
 */

let available = true;
const waiters = new Set<() => void>();

/** Thrown instead of calling the keychain while protected data is unavailable. */
export class ProtectedDataUnavailableError extends Error {
  override readonly name = 'ProtectedDataUnavailableError';

  constructor() {
    super('Protected data is unavailable while the device is locked');
  }
}

export function isProtectedDataAvailable(): boolean {
  return available;
}

/** Throws {@link ProtectedDataUnavailableError} while the device is locked. */
export function assertProtectedDataAvailable(): void {
  if (!available) {
    throw new ProtectedDataUnavailableError();
  }
}

/** Records the native state; a change to available releases every waiter. */
export function setProtectedDataAvailable(next: boolean): void {
  available = next;
  if (!next) {
    return;
  }
  const released = [...waiters];
  waiters.clear();
  for (const release of released) {
    release();
  }
}

/** Resolves at once while available, otherwise at the next unlock. */
export async function whenProtectedDataAvailable(): Promise<void> {
  if (available) {
    return;
  }
  await new Promise<void>(resolve => {
    waiters.add(resolve);
  });
}
