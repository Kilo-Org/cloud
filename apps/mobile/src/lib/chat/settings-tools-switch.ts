import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { SETTINGS_TOOLS_ENABLED_KEY } from '@/lib/storage-keys';

/**
 * The one group switch for the agent-callable settings tools.
 *
 * It is the single source of truth: the settings row that draws it and the
 * tool list an agent is given both read this store, so a manual change and an
 * agent change write one value and neither can disagree with the other. On by
 * default, matching the Kilo-tools default — the user turns it off, and a
 * missing value is on rather than off.
 *
 * Sign-out drops it: `clearSettingsToolsEnabled` resets memory and deletes the
 * persisted value, so the next account starts from the default.
 */
const store = createSecureStorePreference<boolean>({
  key: SETTINGS_TOOLS_ENABLED_KEY,
  defaultValue: true,
  parse: raw => raw !== 'false',
  serialize: value => (value ? 'true' : 'false'),
});

// Warm the disk read at module scope so the tool list an agent is given sees
// the persisted value without waiting for a React mount.
store.preload();

export function isSettingsToolsEnabled(): boolean {
  return store.get();
}

export function setSettingsToolsEnabled(enabled: boolean): void {
  store.set(enabled);
}

export function subscribeSettingsToolsEnabled(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function useSettingsToolsEnabled(): boolean {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function clearSettingsToolsEnabled(): void {
  store.clear();
}
