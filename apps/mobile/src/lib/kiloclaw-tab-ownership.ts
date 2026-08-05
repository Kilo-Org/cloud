import * as SecureStore from 'expo-secure-store';

import { KILOCLAW_OWNED_KEY } from '@/lib/storage-keys';

// The tab bar must decide how many tabs to render on its first frame, before
// the instance list resolves, or the bar visibly shifts once the fetch lands.
// The answer is therefore cached in SecureStore and read synchronously.
let cached: boolean | undefined = undefined;

export function readKiloClawOwned(): boolean {
  if (cached === undefined) {
    try {
      cached = SecureStore.getItem(KILOCLAW_OWNED_KEY) === '1';
    } catch {
      cached = false;
    }
  }
  return cached;
}

// The write is synchronous so no write can still be in flight when sign-out
// deletes the key. An async write could land after the delete and leak the
// previous account's answer into the next account's first frame.
export function persistKiloClawOwned(owned: boolean): void {
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

export async function clearKiloClawOwned(): Promise<void> {
  cached = false;
  await SecureStore.deleteItemAsync(KILOCLAW_OWNED_KEY);
}
