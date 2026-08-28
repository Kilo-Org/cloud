import { useCallback, useMemo, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import {
  buildLiveFilterOptions,
  filterLiveSessions,
  type LiveFilterSession,
} from '@/components/agents/live-session-filters';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { LIVE_SESSION_FILTERS_KEY } from '@/lib/storage-keys';

/**
 * Everything that narrows the live sessions list: the persisted repository and
 * origin filters plus the in-memory search. The whole live set is already
 * loaded, so this filters locally — no refetch, and search needs no debounce.
 */
export function useLiveSessionQuery<T extends LiveFilterSession>(sessions: T[]) {
  const {
    platformFilter,
    projectFilter,
    activeFilterCount,
    setFilters,
    clearFilters,
    setPlatformFilter,
    setProjectFilter,
  } = usePersistedAgentSessionFilters(LIVE_SESSION_FILTERS_KEY);

  // Uncontrolled search input (iOS TextInput rule): the text lives in the
  // input, this state only drives the match and the in-field X.
  const searchInputRef = useRef<TextInput>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleClearSearch = useCallback(() => {
    searchInputRef.current?.clear();
    searchInputRef.current?.blur();
    setSearchQuery('');
  }, []);

  const handleClearAll = useCallback(() => {
    handleClearSearch();
    clearFilters();
  }, [handleClearSearch, clearFilters]);

  const options = useMemo(() => buildLiveFilterOptions(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => filterLiveSessions(sessions, { platformFilter, projectFilter, searchQuery }),
    [sessions, platformFilter, projectFilter, searchQuery]
  );

  const handleRemovePlatform = useCallback(
    (platform: string) => {
      setPlatformFilter(prev => prev.filter(value => value !== platform));
    },
    [setPlatformFilter]
  );
  const handleRemoveProject = useCallback(
    (gitUrl: string) => {
      setProjectFilter(prev => prev.filter(value => value !== gitUrl));
    },
    [setProjectFilter]
  );

  return {
    platformFilter,
    projectFilter,
    activeFilterCount,
    options,
    visibleSessions,
    searchInputRef,
    searchQuery,
    isSearching: searchQuery.trim().length > 0,
    /** True when there is anything to pick, or a pick to undo. */
    canFilter:
      activeFilterCount > 0 || options.projectOptions.length + options.platformOptions.length > 0,
    handleSearchChange: setSearchQuery,
    handleApplyFilters: setFilters,
    handleClearSearch,
    handleClearAll,
    handleRemovePlatform,
    handleRemoveProject,
  };
}
