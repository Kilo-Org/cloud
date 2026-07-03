import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';

import { parseReasoningDefault } from '@/lib/hooks/parse-reasoning-default';
import { REASONING_DEFAULT_EXPANDED_KEY } from '@/lib/storage-keys';

type UseReasoningPreferenceReturn = {
  defaultExpanded: boolean;
  hasLoaded: boolean;
  setDefaultExpanded: (value: boolean) => void;
};

export function useReasoningPreference(): UseReasoningPreferenceReturn {
  const [defaultExpanded, setDefaultExpandedState] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const raw = await SecureStore.getItemAsync(REASONING_DEFAULT_EXPANDED_KEY);
        if (!active) {
          return;
        }
        setDefaultExpandedState(parseReasoningDefault(raw));
      } catch {
        if (active) {
          setDefaultExpandedState(false);
        }
      } finally {
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

  const setDefaultExpanded = useCallback((value: boolean) => {
    setDefaultExpandedState(value);

    const persist = async () => {
      try {
        await SecureStore.setItemAsync(REASONING_DEFAULT_EXPANDED_KEY, value ? 'true' : 'false');
      } catch {
        // Keep in-memory preference even if storage write fails.
      }
    };

    void persist();
  }, []);

  return { defaultExpanded, hasLoaded, setDefaultExpanded };
}
