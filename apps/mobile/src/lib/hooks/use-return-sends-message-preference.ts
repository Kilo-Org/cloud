import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { RETURN_SENDS_MESSAGE_KEY } from '@/lib/storage-keys';

/**
 * Default-off preference: Return inserts a newline unless the user turns
 * "Return sends" on, so the multiline composer keeps its standard newline
 * behavior out of the box.
 */
const store = createSecureStorePreference<boolean>({
  key: RETURN_SENDS_MESSAGE_KEY,
  defaultValue: false,
  parse: raw => raw === 'true',
  serialize: value => (value ? 'true' : 'false'),
});

export function clearReturnSendsMessagePreference() {
  store.clear();
}

function setReturnSendsMessage(value: boolean) {
  store.set(value);
}

export function useReturnSendsMessagePreference() {
  const returnSendsMessage = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { returnSendsMessage, hasLoaded, setReturnSendsMessage };
}
