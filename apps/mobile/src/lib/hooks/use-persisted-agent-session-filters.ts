import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner-native';

import {
  type AgentSessionFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from '@/lib/agent-session-filters';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import { SESSION_FILTERS_KEY } from '@/lib/storage-keys';

type FiltersUpdater = AgentSessionFilters | ((prev: AgentSessionFilters) => AgentSessionFilters);
type StringArrayUpdater = string[] | ((prev: string[]) => string[]);

async function loadStoredFilters(): Promise<AgentSessionFilters> {
  const raw = await SecureStore.getItemAsync(SESSION_FILTERS_KEY);
  return parseStoredAgentSessionFilters(raw) ?? createDefaultAgentSessionFilters();
}

export function usePersistedAgentSessionFilters() {
  const [filters, setFiltersState] = useState<AgentSessionFilters>(() =>
    createDefaultAgentSessionFilters()
  );
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadFilters = async () => {
      try {
        const loadedFilters = await loadStoredFilters();
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
  }, []);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    const saveFilters = async () => {
      try {
        await SecureStore.setItemAsync(SESSION_FILTERS_KEY, JSON.stringify(filters));
      } catch {
        // Keep the in-memory filters so the session still works, but the
        // change won't survive relaunch — tell the user so it's not a silent
        // surprise later.
        toast.error('Could not save setting');
      }
    };

    void saveFilters();
  }, [filters, hasLoaded]);

  const setFilters = useCallback((updater: FiltersUpdater) => {
    setFiltersState(prev => (typeof updater === 'function' ? updater(prev) : updater));
  }, []);

  const setPlatformFilter = useCallback(
    (updater: StringArrayUpdater) => {
      setFilters(prev => ({
        ...prev,
        platformFilter: typeof updater === 'function' ? updater(prev.platformFilter) : updater,
      }));
    },
    [setFilters]
  );

  const setProjectFilter = useCallback(
    (updater: StringArrayUpdater) => {
      setFilters(prev => ({
        ...prev,
        projectFilter: typeof updater === 'function' ? updater(prev.projectFilter) : updater,
      }));
    },
    [setFilters]
  );

  const setSortBy = useCallback(
    (sortBy: AgentSessionSortBy) => {
      setFilters(prev => ({ ...prev, sortBy }));
    },
    [setFilters]
  );

  return {
    platformFilter: filters.platformFilter,
    projectFilter: filters.projectFilter,
    sortBy: filters.sortBy,
    hasLoaded,
    setFilters,
    setPlatformFilter,
    setProjectFilter,
    setSortBy,
  };
}
