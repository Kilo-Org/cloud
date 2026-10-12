import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { HIDE_BALANCE_KEY } from '@/lib/storage-keys';

/** Hidden only when the stored string is exactly `true`. Missing or other values stay visible. */
function parseHideBalance(raw: string | null): boolean {
  return raw === 'true';
}

const store = createSecureStorePreference<boolean>({
  key: HIDE_BALANCE_KEY,
  defaultValue: false,
  parse: parseHideBalance,
  serialize: value => (value ? 'true' : 'false'),
});

export function preloadHideBalancePreference(): void {
  store.preload();
}

export function setHideBalance(value: boolean) {
  store.set(value);
}

/** The stored hide-balance value for callers with no React tree (the settings registry). */
export function getHideBalance(): boolean {
  return store.get();
}

export function useHideBalancePreference() {
  const hideBalance = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { hideBalance, hasLoaded, setHideBalance };
}
