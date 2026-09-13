import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { HIDE_THINKING_KEY } from '@/lib/storage-keys';

/**
 * Default-off preference: only the exact stored string 'true' turns it on, so a
 * missing or unreadable value keeps the thinking rows visible.
 */
export function parseHideThinking(raw: string | null): boolean {
  return raw === 'true';
}

const store = createSecureStorePreference<boolean>({
  key: HIDE_THINKING_KEY,
  defaultValue: false,
  parse: parseHideThinking,
  serialize: value => (value ? 'true' : 'false'),
});

export function clearHideThinkingPreference() {
  store.clear();
}

function setHideThinking(value: boolean) {
  store.set(value);
}

export function useHideThinkingPreference() {
  const hideThinking = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { hideThinking, hasLoaded, setHideThinking };
}
