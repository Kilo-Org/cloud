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
  // A write before the initial disk read settles carries only the one context
  // it set; merging the persisted map back in keeps every other context's
  // default instead of replacing the whole map with the empty default.
  mergeOnLoad: (disk, pending) => ({ ...disk, ...pending }),
});

// Warm the disk read at module scope, the way the sibling preference modules
// do: the settings registry reads and writes this store with no React tree, so
// the map has to be loaded before an agent read (or a write that would
// otherwise replace the other contexts with the empty default).
store.preload();

export function clearAgentModelPreference() {
  store.clear();
}

/** The persisted model/variant for one organization context, if any. */
export function getStoredModelPreference(
  organizationId?: string
): ModelPreferenceEntry | undefined {
  return store.get()[contextKey(organizationId)];
}

/** Persist the model/variant default for one organization context. */
export function setDefaultModelForContext(
  organizationId: string | undefined,
  entry: ModelPreferenceEntry
): void {
  store.set({ ...store.get(), [contextKey(organizationId)]: entry });
}

export function usePersistedAgentModel() {
  const stored = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { stored, hasLoaded, saveModel: setDefaultModelForContext };
}
