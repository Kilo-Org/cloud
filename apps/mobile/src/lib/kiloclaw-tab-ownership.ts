import * as SecureStore from 'expo-secure-store';

import { KILOCLAW_OWNED_KEY } from '@/lib/storage-keys';

// The tab bar must decide how many tabs to render on its first frame, before
// the instance list resolves, or the bar visibly shifts once the fetch lands.
// The answer is therefore cached in SecureStore and read synchronously.
let cached: boolean | undefined = undefined;

// Sign-out deletes the key while the old tab layout observer is still mounted,
// and a late list response in that teardown window could write the previous
// account's answer back. The lock blocks persistence until the next signed-in
// account's tab layout mounts and reads the cleared state.
let persistenceLocked = false;

export function readKiloClawOwned(): boolean {
  if (cached === undefined) {
    try {
      cached = SecureStore.getItem(KILOCLAW_OWNED_KEY) === '1';
    } catch {
      cached = false;
    }
  }
  // The read happens on tab layout mount, which in practice is the next
  // signed-in account, so reopening persistence here cannot unblock a stale
  // observer that only ever calls persist.
  persistenceLocked = false;
  return cached;
}

// The write is synchronous so no write can still be in flight when sign-out
// deletes the key. An async write could land after the delete and leak the
// previous account's answer into the next account's first frame.
export function persistKiloClawOwned(owned: boolean): void {
  if (persistenceLocked) {
    return;
  }
  if (cached === owned) {
    return;
  }
  cached = owned;
  try {
    SecureStore.setItem(KILOCLAW_OWNED_KEY, owned ? '1' : '0');
  } catch {
    // A failed write only costs the next cold start its correct first frame.
  }
}

// Sign-out must close the gate synchronously, at its first line, before any
// teardown await, so a late list response from the old tab layout observer
// cannot write the previous account's answer while the awaits are in flight.
// The cached answer and the native key are left untouched here;
// clearKiloClawOwned resets those once the teardown awaits have completed.
export function gateKiloClawOwned(): void {
  persistenceLocked = true;
}

export async function clearKiloClawOwned(): Promise<void> {
  gateKiloClawOwned();
  cached = false;
  await SecureStore.deleteItemAsync(KILOCLAW_OWNED_KEY);
}
