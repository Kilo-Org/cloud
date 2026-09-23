import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { CONDENSE_TOOL_CALLS_KEY } from '@/lib/storage-keys';

/** On only when the stored string is exactly `true`. Missing or other values stay off. */
export function parseCondenseToolCalls(raw: string | null): boolean {
  return raw === 'true';
}

const store = createSecureStorePreference<boolean>({
  key: CONDENSE_TOOL_CALLS_KEY,
  defaultValue: false,
  parse: parseCondenseToolCalls,
  serialize: value => (value ? 'true' : 'false'),
});

export function clearCondenseToolCallsPreference() {
  store.clear();
}

export function setCondenseToolCalls(value: boolean) {
  store.set(value);
}

/** The stored condense-tool-calls value for callers with no React tree. */
export function getCondenseToolCalls(): boolean {
  return store.get();
}

export function useCondenseToolCallsPreference() {
  const condenseToolCalls = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { condenseToolCalls, hasLoaded, setCondenseToolCalls };
}
