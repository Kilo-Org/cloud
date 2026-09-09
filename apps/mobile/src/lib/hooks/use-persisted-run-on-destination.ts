import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { parseStoredRunOnDestination } from '@/lib/run-on-destination';
import { LAST_RUN_ON_DESTINATION_KEY } from '@/lib/storage-keys';

const store = createSecureStorePreference<string | null>({
  key: LAST_RUN_ON_DESTINATION_KEY,
  defaultValue: null,
  parse: parseStoredRunOnDestination,
  serialize: value => value ?? '',
});

export function clearRunOnDestinationPreference() {
  store.clear();
}

function saveRunOn(connectionId: string | null) {
  store.set(connectionId);
}

export function usePersistedRunOnDestination() {
  const storedConnectionId = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { storedConnectionId, hasLoaded, saveRunOn };
}
