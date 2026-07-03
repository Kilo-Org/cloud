import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { REASONING_DEFAULT_EXPANDED_KEY } from '@/lib/storage-keys';

const store = createSecureStorePreference<boolean>({
  key: REASONING_DEFAULT_EXPANDED_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

export function clearReasoningPreference() {
  store.clear();
}

function setDefaultExpanded(value: boolean) {
  store.set(value);
}

export function useReasoningPreference() {
  const defaultExpanded = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { defaultExpanded, hasLoaded, setDefaultExpanded };
}
