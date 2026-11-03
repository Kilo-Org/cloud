/**
 * Dev-only locked-keychain fixture. `kiloapp:///dev/locked-keychain/lock`
 * marks protected data unavailable and drops the in-memory token owner, the
 * state a process that starts on a locked iOS device has before its first
 * unlock; `.../unlock` restores availability and leaves the owner cold, so the
 * next request performs the cold read. iOS supplies the availability from the
 * `KiloProtectedData` native module; Android has no such module, so this
 * harness calls the same setter that module feeds. The only entry point is
 * `+native-intent.tsx`, behind `__DEV__`.
 */

import { clearActiveToken } from '@/lib/auth/token-owner';
import { setProtectedDataAvailable } from '@/lib/protected-data';

const FIXTURE_PATH = /(?:^|\/)dev\/locked-keychain\/([\w-]+)\/?(?:[?#].*)?$/;
const LOCK = 'lock';
const UNLOCK = 'unlock';

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[locked-keychain-fixture] ${message}`);
}

/**
 * Handle a fixture link. True when the path is a fixture link (handled, even
 * when the name is unknown), so the caller returns falsy and nothing navigates.
 */
export function handleLockedKeychainFixturePath(path: string): boolean {
  const name = FIXTURE_PATH.exec(path)?.[1];
  if (name === undefined) {
    return false;
  }
  if (name === LOCK) {
    clearActiveToken();
    setProtectedDataAvailable(false);
    log('locked, token owner cleared');
  } else if (name === UNLOCK) {
    setProtectedDataAvailable(true);
    log('unlocked, token owner still cold');
  } else {
    log(`unknown fixture ${name}`);
  }
  return true;
}
