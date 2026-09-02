import { useSyncExternalStore } from 'react';

import {
  parseGlanceableEnabled,
  serializeGlanceableEnabled,
} from '@/lib/glanceable/enabled';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { GLANCEABLE_ENABLED_KEY } from '@/lib/storage-keys';

/** Reactive view of the Active Agents master switch; see `glanceable/enabled`. */
const store = createSecureStorePreference<boolean>({
  key: GLANCEABLE_ENABLED_KEY,
  defaultValue: true,
  parse: parseGlanceableEnabled,
  serialize: serializeGlanceableEnabled,
});

export function clearGlanceablePreference() {
  store.clear();
}

function setGlanceableEnabled(value: boolean) {
  store.set(value);
}

export function useGlanceablePreference() {
  const glanceableEnabled = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { glanceableEnabled, hasLoaded, setGlanceableEnabled };
}
