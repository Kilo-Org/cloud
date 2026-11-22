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

export function clearAgentModelPreference() {
  store.clear();
}

/** The persisted model/variant for one organization context, if any. */
export function getStoredModelPreference(
  organizationId?: string
): ModelPreferenceEntry | undefined {
  return store.getRequested()[contextKey(organizationId)];
}

/** Persist the model/variant default for one organization context. */
export function setDefaultModelForContext(
  organizationId: string | undefined,
  entry: ModelPreferenceEntry
): void {
  store.set({ ...store.getRequested(), [contextKey(organizationId)]: entry });
}

export function usePersistedAgentModel() {
  const stored = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { stored, hasLoaded, saveModel: setDefaultModelForContext };
}
