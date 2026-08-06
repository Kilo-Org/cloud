import { useCallback, useMemo } from 'react';

import {
  excludeActiveFromGroups,
  expandPlatformFilter,
  formatGitUrlProject,
  selectPinnedActiveSessions,
  type SessionSection,
} from '@/components/agents/session-list-helpers';
import { shouldBackfillHistoryAfterActiveExclusion } from '@/components/agents/session-list-backfill';
import { selectEffectiveSearchQuery } from '@/components/agents/session-list-search-busy';
import { useHistoryBackfill } from '@/components/agents/use-history-backfill';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import {
  useAgentSessions,
  useAgentSessionSearch,
  useRecentAgentRepositories,
} from '@/lib/hooks/use-agent-sessions';

export function useAgentSessionListData(options: {
  organizationId: string | null;
  platformFilter: string[];
  projectFilter: string[];
  sortBy: AgentSessionSortBy;
  ready: boolean;
  searchQuery: string;
}) {
  const { organizationId, platformFilter, projectFilter, sortBy, ready, searchQuery } = options;
  const createdOnPlatform = useMemo(
    () => (platformFilter.length > 0 ? expandPlatformFilter(platformFilter) : undefined),
    [platformFilter]
  );
  const gitUrl = useMemo(
    () => (projectFilter.length > 0 ? projectFilter : undefined),
    [projectFilter]
  );
  const {
    storedSessions,
    dateGroups,
    activeSessions,
    activeSessionIds,
    activeIsError,
    isLoading,
    storedIsError,
    storedIsFetching,
    storedLoadedPageCount,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useAgentSessions({
    createdOnPlatform,
    gitUrl,
    organizationId,
    enabled: ready,
    sortBy,
    // The Agents screen drives app-foreground refresh through the AppState
    // 'active' listener and the wrapped `refetch`, so the stored query opts
    // out of React Query's native window-focus refetch (Home and the Share
    // Gate keep the native default through `buildStoredSessionsQueryOptions`).
    refetchOnWindowFocus: false,
  });
  const isSearching = searchQuery.length > 0;
  const search = useAgentSessionSearch({
    searchQuery,
    createdOnPlatform,
    gitUrl,
    organizationId,
    enabled: ready && isSearching,
    sortBy,
  });
  const { data: recentRepositories } = useRecentAgentRepositories({
    organizationId,
    enabled: ready,
  });
  const contentIsError = isSearching ? search.isError : storedIsError;
  const handleRetry = useCallback(() => {
    if (!isSearching) {
      void refetch();
      return;
    }
    if (activeIsError) {
      void (async () => {
        await Promise.all([search.refetch(), refetch()]);
      })();
      return;
    }
    void search.refetch();
  }, [activeIsError, isSearching, refetch, search]);
  const handleRefetch = useCallback(async () => {
    if (isSearching) {
      await Promise.all([search.refetch(), refetch()]);
      return;
    }
    await refetch();
  }, [isSearching, refetch, search]);
  const effectiveSearchQuery = selectEffectiveSearchQuery({
    isSearching,
    isPending: search.isPending,
    searchQuery,
  });

  const paging = useMemo(
    () =>
      effectiveSearchQuery
        ? {
            hasNextPage: search.hasNextPage,
            isFetchingNextPage: search.isFetchingNextPage,
            isPlaceholderData: search.isPlaceholderData,
            fetchNextPage: search.fetchNextPage,
          }
        : {
            hasNextPage,
            isFetchingNextPage,
            isPlaceholderData: false,
            fetchNextPage,
          },
    [
      effectiveSearchQuery,
      hasNextPage,
      isFetchingNextPage,
      fetchNextPage,
      search.hasNextPage,
      search.isFetchingNextPage,
      search.isPlaceholderData,
      search.fetchNextPage,
    ]
  );
  const pinnedActive = useMemo(
    () =>
      selectPinnedActiveSessions({
        activeSessions,
        projectFilter,
        platformFilter,
        searchQuery: effectiveSearchQuery,
      }),
    [activeSessions, effectiveSearchQuery, platformFilter, projectFilter]
  );
  const sections = useMemo<SessionSection[]>(() => {
    const storedGroups = effectiveSearchQuery ? search.dateGroups : dateGroups;
    return excludeActiveFromGroups(storedGroups, activeSessionIds).map(group => ({
      title: group.label,
      data: group.sessions,
    }));
  }, [activeSessionIds, dateGroups, effectiveSearchQuery, search.dateGroups]);
  // Bounded automatic backfill: when active-set exclusion empties every
  // rendered stored page and no gate (search, loading, error, in-flight
  // stored fetch, page bound) blocks, fetch the next stored page so history
  // still surfaces below a viewport-filling tray. `paging` selects the search
  // vs stored pagination; the `isSearching` gate keeps the stored fetch from
  // ever firing during committed search mode.
  const shouldBackfill = useMemo(
    () =>
      shouldBackfillHistoryAfterActiveExclusion({
        hasHistoryContent: sections.length > 0,
        hasStoredSessions: storedSessions.length > 0,
        hasMoreHistory: paging.hasNextPage,
        isFetchingNextPage: paging.isFetchingNextPage,
        isFetching: storedIsFetching,
        isSearching,
        isLoading,
        isError: contentIsError,
        loadedPageCount: storedLoadedPageCount,
      }),
    [
      contentIsError,
      isLoading,
      isSearching,
      paging.hasNextPage,
      paging.isFetchingNextPage,
      sections,
      storedIsFetching,
      storedLoadedPageCount,
      storedSessions,
    ]
  );
  useHistoryBackfill({ shouldBackfill, fetchNextPage: paging.fetchNextPage });
  const projectOptions = useMemo(() => {
    const byGitUrl = new Map<string, { gitUrl: string; displayName: string }>();
    for (const project of recentRepositories?.repositories.slice(0, 3) ?? []) {
      byGitUrl.set(project.gitUrl, {
        gitUrl: project.gitUrl,
        displayName: formatGitUrlProject(project.gitUrl),
      });
    }
    for (const selectedGitUrl of projectFilter) {
      if (!byGitUrl.has(selectedGitUrl)) {
        byGitUrl.set(selectedGitUrl, {
          gitUrl: selectedGitUrl,
          displayName: formatGitUrlProject(selectedGitUrl),
        });
      }
    }
    return [...byGitUrl.values()];
  }, [projectFilter, recentRepositories?.repositories]);

  return {
    storedSessions,
    activeSessions,
    activeIsError,
    isLoading,
    paging,
    refetch,
    handleRetry,
    handleRefetch,
    isSearching,
    search,
    projectOptions,
    contentIsError,
    pinnedActive,
    sections,
    effectiveSearchQuery,
  };
}
