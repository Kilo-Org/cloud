import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { setAccountMetadata } from '@/lib/auth/account-metadata-write';
import {
  type AgentSessionFilters,
  countActiveSessionFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from '@/lib/agent-session-filters';

type StringArrayUpdater = string[] | ((prev: string[]) => string[]);

async function loadStoredFilters(storageKey: string): Promise<AgentSessionFilters> {
  const raw = await SecureStore.getItemAsync(storageKey);
  return parseStoredAgentSessionFilters(raw) ?? createDefaultAgentSessionFilters();
}

/**
 * Persisted narrowing filters for one session-list page. The storage key is a
 * parameter because the live and history pages filter separate lists and must
 * not share a record.
 */
export function usePersistedAgentSessionFilters(storageKey: string) {
  const [filters, setFiltersState] = useState<AgentSessionFilters>(() =>
    createDefaultAgentSessionFilters()
  );
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadFilters = async () => {
      try {
        const loadedFilters = await loadStoredFilters(storageKey);
        if (isActive) {
          setFiltersState(loadedFilters);
        }
      } catch {
        if (isActive) {
          setFiltersState(createDefaultAgentSessionFilters());
        }
      } finally {
        if (isActive) {
          setHasLoaded(true);
        }
      }
    };

    void loadFilters();

    return () => {
      isActive = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    const saveFilters = async () => {
      try {
        await setAccountMetadata(storageKey, JSON.stringify(filters));
      } catch {
        // Keep the in-memory filters so the session still works, but the
        // change won't survive relaunch — tell the user so it's not a silent
        // surprise later.
        toast.error(i18n.t('common.couldNotSaveSetting'));
      }
    };

    void saveFilters();
  }, [filters, hasLoaded, storageKey]);

  const setFilters = useCallback((next: AgentSessionFilters) => {
    setFiltersState(next);
  }, []);

  const clearFilters = useCallback(() => {
    setFiltersState(createDefaultAgentSessionFilters());
  }, []);

  const setPlatformFilter = useCallback((updater: StringArrayUpdater) => {
    setFiltersState(prev => ({
      ...prev,
      platformFilter: Array.isArray(updater) ? updater : updater(prev.platformFilter),
    }));
  }, []);

  const setProjectFilter = useCallback((updater: StringArrayUpdater) => {
    setFiltersState(prev => ({
      ...prev,
      projectFilter: Array.isArray(updater) ? updater : updater(prev.projectFilter),
    }));
  }, []);

  return {
    platformFilter: filters.platformFilter,
    projectFilter: filters.projectFilter,
    activeFilterCount: countActiveSessionFilters(filters),
    hasLoaded,
    setFilters,
    clearFilters,
    setPlatformFilter,
    setProjectFilter,
  };
}
