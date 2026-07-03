import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  contextKey,
  type ModelPreferenceEntry,
  parseStoredModelPreference,
  type StoredModelPreference,
} from '@/lib/hooks/agent-model-preference';
import { AGENT_MODEL_PREFERENCE_KEY } from '@/lib/storage-keys';

export function usePersistedAgentModel() {
  const [stored, setStored] = useState<StoredModelPreference>({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const storedRef = useRef<StoredModelPreference>({});

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const raw = await SecureStore.getItemAsync(AGENT_MODEL_PREFERENCE_KEY);
        if (!active) {
          return;
        }
        const parsed = parseStoredModelPreference(raw);
        storedRef.current = parsed;
        setStored(parsed);
        setHasLoaded(true);
      } catch {
        if (active) {
          setHasLoaded(true);
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, []);

  const saveModel = useCallback(
    (organizationId: string | undefined, entry: ModelPreferenceEntry) => {
      const key = contextKey(organizationId);
      const next = { ...storedRef.current, [key]: entry };
      storedRef.current = next;
      setStored(next);

      const persist = async () => {
        try {
          await SecureStore.setItemAsync(AGENT_MODEL_PREFERENCE_KEY, JSON.stringify(next));
        } catch {
          // Keep in-memory preference even if storage write fails.
        }
      };

      void persist();
    },
    []
  );

  return { stored, hasLoaded, saveModel };
}
