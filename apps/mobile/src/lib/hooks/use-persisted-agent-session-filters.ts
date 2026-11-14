import * as SecureStore from '@/lib/auth/secure-store';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { setAccountMetadata } from '@/lib/auth/account-metadata-write';
import {
  type AgentSessionFilters,
  countActiveSessionFilters,
  createDefaultAgentSessionFilters,
  parseStoredAgentSessionFilters,
  sameAgentSessionFilters,
} from '@/lib/agent-session-filters';

type StringArrayUpdater = string[] | ((prev: string[]) => string[]);

async function loadStoredFilters(storageKey: string): Promise<AgentSessionFilters> {
  const raw = await SecureStore.getItemAsync(storageKey);
  return parseStoredAgentSessionFilters(raw) ?? createDefaultAgentSessionFilters();
}

/**
 * Where the persisted filters are in their life for this storage key.
 *
 * `unreadable` means the read failed: the defaults on screen are not the stored
 * value, so nothing may be written until the person edits them. `edited` records
 * that they have since changed something, which makes a write legitimate.
 */
type SavedFilters =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unreadable'; readonly edited: boolean }
  | { readonly kind: 'ready'; readonly stored: AgentSessionFilters };

/**
 * Persisted narrowing filters for one session-list page. The storage key is a
 * parameter because the live and history pages filter separate lists and must
 * not share a record.
 */
export function usePersistedAgentSessionFilters(storageKey: string) {
  const [filters, setFiltersState] = useState<AgentSessionFilters>(() =>
    createDefaultAgentSessionFilters()
  );
  const [saved, setSaved] = useState<SavedFilters>({ kind: 'loading' });

  useEffect(() => {
    let isActive = true;

    const loadFilters = async () => {
      try {
        const loadedFilters = await loadStoredFilters(storageKey);
        if (isActive) {
          setFiltersState(loadedFilters);
          setSaved({ kind: 'ready', stored: loadedFilters });
        }
      } catch {
        if (isActive) {
          setFiltersState(createDefaultAgentSessionFilters());
          setSaved({ kind: 'unreadable', edited: false });
          // The defaults on screen are not what is stored: say the read failed
          // instead of blaming the write that follows it.
          toast.error(i18n.t('common.couldnTLoad'));
        }
      }
    };

    void loadFilters();

    return () => {
      isActive = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (saved.kind === 'loading') {
      return;
    }
    if (saved.kind === 'unreadable' && !saved.edited) {
      return;
    }
    if (saved.kind === 'ready' && sameAgentSessionFilters(filters, saved.stored)) {
      return;
    }

    const saveFilters = async () => {
      try {
        // `setAccountMetadata` already serializes its writes per key.
        await setAccountMetadata(storageKey, JSON.stringify(filters));
        setSaved({ kind: 'ready', stored: filters });
      } catch {
        // Keep the in-memory filters so the session still works, but the
        // change won't survive relaunch — tell the user so it's not a silent
        // surprise later. The saved state stays as it was, so a later edit
        // retries the write.
        toast.error(i18n.t('common.couldNotSaveSetting'));
      }
    };

    void saveFilters();
  }, [filters, saved, storageKey]);

  const markEdited = useCallback(() => {
    setSaved(prev => (prev.kind === 'unreadable' ? { kind: 'unreadable', edited: true } : prev));
  }, []);

  /*
   * A load that could not read the stored filters leaves the defaults on
   * screen, and the filter sheet's Apply sends its draft whether or not the
   * person changed it. Only a real change may mark the filters edited: a no-op
   * Apply would otherwise write those defaults over the record the read could
   * not load, which is the overwrite this state exists to prevent.
   */
  const applyFilters = useCallback(
    (next: AgentSessionFilters) => {
      if (sameAgentSessionFilters(next, filters)) {
        return;
      }
      markEdited();
      setFiltersState(next);
    },
    [filters, markEdited]
  );

  const setFilters = applyFilters;

  const clearFilters = useCallback(() => {
    applyFilters(createDefaultAgentSessionFilters());
  }, [applyFilters]);

  const setPlatformFilter = useCallback(
    (updater: StringArrayUpdater) => {
      markEdited();
      setFiltersState(prev => ({
        ...prev,
        platformFilter: Array.isArray(updater) ? updater : updater(prev.platformFilter),
      }));
    },
    [markEdited]
  );

  const setProjectFilter = useCallback(
    (updater: StringArrayUpdater) => {
      markEdited();
      setFiltersState(prev => ({
        ...prev,
        projectFilter: Array.isArray(updater) ? updater : updater(prev.projectFilter),
      }));
    },
    [markEdited]
  );

  return {
    platformFilter: filters.platformFilter,
    projectFilter: filters.projectFilter,
    activeFilterCount: countActiveSessionFilters(filters),
    hasLoaded: saved.kind !== 'loading',
    setFilters,
    clearFilters,
    setPlatformFilter,
    setProjectFilter,
  };
}
