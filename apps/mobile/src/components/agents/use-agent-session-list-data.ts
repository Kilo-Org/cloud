import { useCallback, useMemo } from 'react';

import {
  expandPlatformFilter,
  formatGitUrlProject,
  normalisePlatformSelection,
  type SessionSection,
} from '@/components/agents/session-list-helpers';
import { selectEffectiveSearchQuery } from '@/components/agents/session-list-search-busy';
import { SESSION_LIST_SORT } from '@/lib/agent-session-sort';
import {
  useAgentSessions,
  useAgentSessionSearch,
  useRecentAgentRepositories,
} from '@/lib/hooks/use-agent-sessions';
import {
  useCommittedConnectivityStatus,
  useConnectivityStatus,
} from '@/lib/hooks/use-offline-banner-state';

export function useAgentSessionListData(options: {
  organizationId: string | null;
  platformFilter: string[];
  projectFilter: string[];
  ready: boolean;
  searchQuery: string;
}) {
  const { organizationId, platformFilter, projectFilter, ready, searchQuery } = options;
  const sortBy = SESSION_LIST_SORT;
  const createdOnPlatform = useMemo(() => {
    if (platformFilter.length === 0) {
      return undefined;
    }
    // Collapse a persisted variant into its bucket first, so the history query
    // covers the raw platforms of the single row the sheet checks.
    return expandPlatformFilter(normalisePlatformSelection(platformFilter));
  }, [platformFilter]);
  const gitUrl = useMemo(
    () => (projectFilter.length > 0 ? projectFilter : undefined),
    [projectFilter]
  );
  const {
    storedSessions,
    activeSessionIds,
    dateGroups,
    activeIsError,
    storedIsError,
    storedIsPending,
    storedIsPaused,
    storedFetchedSinceMount,
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
    // The history screen drives focus and app-foreground refresh through the
    // AppState 'active' listener and the wrapped `handleRefetch`, so the stored
    // query opts out of React Query's native window-focus refetch (Home and the
    // Share Gate keep the native default through `buildStoredSessionsQueryOptions`).
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
  // A paused query (offline, NetInfo down) is neither loading nor errored, but
  // it has no rows and will not resolve until the network returns. Surface a
  // *confirmed-offline* pause as the body-driving error so the list settles out
  // of its skeletons and offers the retry affordance instead of spinning
  // forever.
  //
  // React Query pauses on NetInfo's boot `unknown` reachability too (the app
  // maps `unknown` to offline for `onlineManager`), which is not a user-visible
  // outage: the query resumes the moment reachability settles. Mapping that
  // boot pause to the error flashed the full-screen "Could not load sessions"
  // on a healthy cold launch before the first fetch could start. A known
  // committed connectivity state turns the pause into an error, so the boot
  // pause keeps its skeleton (and any cached rows). Same rule as ScopeEntryScreen.
  //
  // The committed state alone settles a confirmed-offline cold start too late:
  // the banner debounces the offline report for five seconds before committing
  // it, so the paused history sat on its skeletons with no retry past the proof
  // window. NetInfo's immediate classification is already a definite `offline`
  // on that cold start, and a definite `offline` is not the boot-`unknown`
  // pause, so the pause becomes an error at once. A boot-`unknown` report stays
  // `unknown` here and still keeps the skeleton.
  const committedConnectivity = useCommittedConnectivityStatus();
  const sourceConnectivity = useConnectivityStatus();
  const isConnectivityKnown =
    committedConnectivity !== 'unknown' || sourceConnectivity === 'offline';
  const contentIsPaused = (isSearching ? search.isPaused : storedIsPaused) && isConnectivityKnown;
  const contentIsError = isSearching
    ? search.isError || contentIsPaused
    : storedIsError || contentIsPaused;
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
  const sections = useMemo<SessionSection[]>(() => {
    const storedGroups = effectiveSearchQuery ? search.dateGroups : dateGroups;
    return storedGroups.map(group => ({
      title: group.label,
      data: group.sessions,
    }));
  }, [dateGroups, effectiveSearchQuery, search.dateGroups]);
  const projectOptions = useMemo(() => {
    const byGitUrl = new Map<string, { gitUrl: string; displayName: string }>();
    // The server already bounds `recentRepositories` (LIMIT 10); offer every row
    // it returns so older repositories stay filterable. A client-side cap here
    // silently drops the rows the user needs to narrow the list.
    for (const project of recentRepositories?.repositories ?? []) {
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
    activeSessionIds,
    storedIsPending,
    storedFetchedSinceMount,
    paging,
    refetch,
    handleRetry,
    handleRefetch,
    isSearching,
    search,
    projectOptions,
    contentIsError,
    contentIsPaused,
    sections,
  };
}
