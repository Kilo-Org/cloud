import { useSyncExternalStore } from 'react';

import {
  contextKey,
  type ModelPreferenceEntry,
  parseStoredModelPreference,
  type StoredModelPreference,
} from '@/lib/hooks/agent-model-preference';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { AGENT_MODEL_PREFERENCE_KEY } from '@/lib/storage-keys';

const store = createSecureStorePreference<StoredModelPreference>({
  key: AGENT_MODEL_PREFERENCE_KEY,
  defaultValue: {},
  parse: parseStoredModelPreference,
  serialize: value => JSON.stringify(value),
});

export function clearAgentModelPreference() {
  store.clear();
}

function saveModel(organizationId: string | undefined, entry: ModelPreferenceEntry) {
  store.set({ ...store.get(), [contextKey(organizationId)]: entry });
}

export function usePersistedAgentModel() {
  const stored = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { stored, hasLoaded, saveModel };
}
