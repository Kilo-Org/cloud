import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { KEEP_SCREEN_ON_KEY } from '@/lib/storage-keys';

/**
 * Default-on preference: only the exact stored string 'false' turns it off, so a
 * missing or unreadable value keeps the screen-awake behavior the app ships with.
 */
export function parseKeepScreenOn(raw: string | null): boolean {
  return raw !== 'false';
}

const store = createSecureStorePreference<boolean>({
  key: KEEP_SCREEN_ON_KEY,
  defaultValue: true,
  parse: parseKeepScreenOn,
  serialize: value => (value ? 'true' : 'false'),
});

export function clearKeepScreenOnPreference() {
  store.clear();
}

function setKeepScreenOn(value: boolean) {
  store.set(value);
}

export function useKeepScreenOnPreference() {
  const keepScreenOn = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { keepScreenOn, hasLoaded, setKeepScreenOn };
}
