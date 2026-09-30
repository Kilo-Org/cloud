import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { setAccountMetadata } from '@/lib/auth/account-metadata-write';
import { readStoredValueForUpdate } from '@/lib/auth/secure-store-value';
import {
  type AgentSessionFilters,
  countActiveSessionFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
} from '@/lib/agent-session-filters';

type StringArrayUpdater = string[] | ((prev: string[]) => string[]);

/**
 * The stored filters, or `null` when the read failed. `null` is not "nothing
 * stored": `readStoredValueForUpdate` keeps a failed read apart from an absent
 * one so the caller never persists the fallback defaults over the record a
 * transient keychain failure prevented it from reading.
 */
async function loadStoredFilters(storageKey: string): Promise<AgentSessionFilters | null> {
  const read = await readStoredValueForUpdate(storageKey);
  if (read.status === 'unreadable') {
    return null;
  }
  return parseStoredAgentSessionFilters(read.value) ?? createDefaultAgentSessionFilters();
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
  // Whether the in-memory filters may be written back. A stored record we
  // actually read (or confirmed absent) is authoritative, and so is a value the
  // person just set. The fallback defaults after an unreadable read are neither:
  // persisting them would overwrite the stored filters the read never saw.
  const [canPersist, setCanPersist] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadFilters = async () => {
      const loadedFilters = await loadStoredFilters(storageKey);
      if (!isActive) {
        return;
      }
      if (loadedFilters !== null) {
        setFiltersState(loadedFilters);
        setCanPersist(true);
      }
      setHasLoaded(true);
    };

    void loadFilters();

    return () => {
      isActive = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!hasLoaded || !canPersist) {
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
  }, [filters, hasLoaded, canPersist, storageKey]);

  const setFilters = useCallback((next: AgentSessionFilters) => {
    setCanPersist(true);
    setFiltersState(next);
  }, []);

  const clearFilters = useCallback(() => {
    setCanPersist(true);
    setFiltersState(createDefaultAgentSessionFilters());
  }, []);

  const setPlatformFilter = useCallback((updater: StringArrayUpdater) => {
    setCanPersist(true);
    setFiltersState(prev => ({
      ...prev,
      platformFilter: Array.isArray(updater) ? updater : updater(prev.platformFilter),
    }));
  }, []);

  const setProjectFilter = useCallback((updater: StringArrayUpdater) => {
    setCanPersist(true);
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
