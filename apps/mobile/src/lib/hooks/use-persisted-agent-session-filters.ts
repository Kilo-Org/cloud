import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';

import { SESSION_FILTERS_KEY } from '@/lib/storage-keys';

type AgentSessionFilters = {
  platformFilter: string[];
  projectFilter: string[];
};

type FiltersUpdater = AgentSessionFilters | ((prev: AgentSessionFilters) => AgentSessionFilters);
type StringArrayUpdater = string[] | ((prev: string[]) => string[]);
const DEFAULT_PLATFORM_FILTER = ['cloud-agent'];

function createDefaultFilters(): AgentSessionFilters {
  return {
    platformFilter: [...DEFAULT_PLATFORM_FILTER],
    projectFilter: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(item => typeof item === 'string');
}

function parseStoredFilters(raw: string | null): AgentSessionFilters | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      platformFilter: readStringArray(parsed.platformFilter),
      projectFilter: readStringArray(parsed.projectFilter),
    };
  } catch {
    return null;
  }
}

async function loadStoredFilters(): Promise<AgentSessionFilters> {
  const raw = await SecureStore.getItemAsync(SESSION_FILTERS_KEY);
  return parseStoredFilters(raw) ?? createDefaultFilters();
}

export function usePersistedAgentSessionFilters() {
  const [filters, setFiltersState] = useState<AgentSessionFilters>(() => createDefaultFilters());
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
          setFiltersState(createDefaultFilters());
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
        // Keep the in-memory filters even if local preference storage fails.
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

  return {
    platformFilter: filters.platformFilter,
    projectFilter: filters.projectFilter,
    hasLoaded,
    setFilters,
    setPlatformFilter,
    setProjectFilter,
  };
}
