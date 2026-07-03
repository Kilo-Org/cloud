import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';

import { LAST_SELECTED_MODEL_KEY } from '@/lib/storage-keys';

type PersistedAgentModel = {
  modelId: string;
  variant: string;
};

function parsePersistedModel(raw: string | null): PersistedAgentModel | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const modelId = (parsed as Record<string, unknown>).modelId;
    const variant = (parsed as Record<string, unknown>).variant;
    if (typeof modelId !== 'string' || modelId.length === 0) {
      return null;
    }
    return {
      modelId,
      variant: typeof variant === 'string' ? variant : '',
    };
  } catch {
    return null;
  }
}

export function usePersistedAgentModel() {
  const [value, setValueState] = useState<PersistedAgentModel | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;
    const load = async () => {
      try {
        const raw = await SecureStore.getItemAsync(LAST_SELECTED_MODEL_KEY);
        if (isActive) {
          setValueState(parsePersistedModel(raw));
        }
      } catch {
        if (isActive) {
          setValueState(null);
        }
      } finally {
        if (isActive) {
          setHasLoaded(true);
        }
      }
    };
    void load();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }
    const save = async () => {
      try {
        const payload = value === null ? null : JSON.stringify(value);
        await (payload === null
          ? SecureStore.deleteItemAsync(LAST_SELECTED_MODEL_KEY)
          : SecureStore.setItemAsync(LAST_SELECTED_MODEL_KEY, payload));
      } catch {
        // Keep the in-memory value even if local preference storage fails.
      }
    };
    void save();
  }, [value, hasLoaded]);

  const setModel = useCallback(
    (
      updater:
        | PersistedAgentModel
        | null
        | ((prev: PersistedAgentModel | null) => PersistedAgentModel | null)
    ) => {
      setValueState(prev => (typeof updater === 'function' ? updater(prev) : updater));
    },
    []
  );

  return { value, hasLoaded, setModel };
}
