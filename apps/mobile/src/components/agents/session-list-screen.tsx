import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { AgentSessionListContent } from '@/components/agents/session-list-content';
import { SessionListHeaderActions } from '@/components/agents/session-list-header-actions';
import {
  type ProjectFilterOption,
  SessionFilterChips,
  SessionFilterModal,
} from '@/components/agents/platform-filter-modal';
import { buildSessionSections } from '@/components/agents/session-list-sections';
import {
  expandPlatformFilter,
  formatGitUrlProject,
} from '@/components/agents/session-list-helpers';
import { ScreenHeader } from '@/components/screen-header';
import {
  useAgentSessions,
  useAgentSessionSearch,
  useRecentAgentRepositories,
} from '@/lib/hooks/use-agent-sessions';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { useOrganization } from '@/lib/organization-context';

import { type Href, useFocusEffect, useRouter } from 'expo-router';

export function AgentSessionListScreen() {
  const router = useRouter();

  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const {
    activeNow,
    platformFilter,
    projectFilter,
    hasLoaded: filtersLoaded,
    setFilters,
    setActiveNow,
    setPlatformFilter,
    setProjectFilter,
  } = usePersistedAgentSessionFilters();
  const [showFilterModal, setShowFilterModal] = useState(false);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchChange = useCallback((text: string) => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(text.trim());
    }, 300);
  }, []);

  const handleClearSearch = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }
    setSearchQuery('');
  }, []);

  useEffect(
    () => () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    },
    []
  );

  const createdOnPlatform = useMemo(
    () => (platformFilter.length > 0 ? expandPlatformFilter(platformFilter) : undefined),
    [platformFilter]
  );
  const gitUrl = useMemo(
    () => (projectFilter.length > 0 ? projectFilter : undefined),
    [projectFilter]
  );

  const ready = filtersLoaded && orgLoaded;
  const {
    storedSessions,
    dateGroups,
    activeSessions,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useAgentSessions({
    createdOnPlatform,
    gitUrl,
    organizationId,
    enabled: ready,
  });
  const isSearching = searchQuery.length > 0;
  const search = useAgentSessionSearch({
    searchQuery,
    createdOnPlatform,
    gitUrl,
    organizationId,
    enabled: ready && isSearching,
  });
  const { data: recentRepositories } = useRecentAgentRepositories({
    organizationId,
    enabled: ready,
  });

  // While searching, only the search query's own error/pending state matters —
  // it's the one actually driving what's on screen. Retrying should hit
  // whichever query is really in error instead of always refetching the base
  // list underneath a failed search.
  const contentIsError = isSearching ? search.isError : isError;
  const isSearchPending = isSearching && search.isPending;
  const searchRefetch = search.refetch;
  const handleRetry = useCallback(() => {
    if (isSearching) {
      void searchRefetch();
    } else {
      void refetch();
    }
  }, [isSearching, searchRefetch, refetch]);

  // Pull-to-refresh must also retry the search query while one is active —
  // it's the query actually driving what's on screen.
  const handleRefetch = useCallback(async () => {
    if (!isSearching) {
      await refetch();
      return;
    }
    await Promise.all([searchRefetch(), refetch()]);
  }, [isSearching, refetch, searchRefetch]);

  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useFocusEffect(
    useCallback(() => {
      void refetchRef.current();
    }, [])
  );

  const projectOptions = useMemo((): ProjectFilterOption[] => {
    const byGitUrl = new Map<string, ProjectFilterOption>();

    const repositories = recentRepositories?.repositories ?? [];
    for (const project of repositories.slice(0, 3)) {
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

  // While the first fetch for this search text is still in flight (no
  // keepPreviousData to fall back on yet), render as if no search were
  // applied instead of blanking to an empty/mismatched list —
  // `isSearchPending` drives a lightweight inline indicator instead.
  const effectiveSearchQuery = isSearchPending ? '' : searchQuery;

  // Stored sessions are cursor-paginated, so a client-side filter would only
  // see the loaded pages. When a query is active, use the server search
  // results (which cover the full history) instead.
  const storedGroups = useMemo(
    () => (effectiveSearchQuery ? search.dateGroups : dateGroups),
    [dateGroups, effectiveSearchQuery, search.dateGroups]
  );

  const sections = useMemo(
    () =>
      buildSessionSections({
        activeNow,
        activeSessions,
        storedGroups,
        platformFilter,
        projectFilter,
        searchQuery: effectiveSearchQuery,
        organizationId,
      }),
    [
      activeNow,
      activeSessions,
      effectiveSearchQuery,
      organizationId,
      platformFilter,
      projectFilter,
      storedGroups,
    ]
  );

  const navigateToSession = useCallback(
    (sessionId: string, sessionOrgId?: string | null) => {
      const path = sessionOrgId
        ? `/(app)/agent-chat/${sessionId}?organizationId=${sessionOrgId}`
        : `/(app)/agent-chat/${sessionId}`;
      router.push(path as Href);
    },
    [router]
  );

  const handleEndReached = useCallback(() => {
    if (!isSearching && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, isSearching]);

  const hasActiveFilter = activeNow || platformFilter.length > 0 || projectFilter.length > 0;
  const hasAnySessions = storedSessions.length > 0 || activeSessions.length > 0;

  const handleClearQuery = useCallback(() => {
    handleClearSearch();
    setFilters({ activeNow: false, platformFilter: [], projectFilter: [] });
  }, [handleClearSearch, setFilters]);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Agents"
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={
          <SessionListHeaderActions
            hasActiveFilter={hasActiveFilter}
            showNewSession={hasAnySessions}
            onNewSession={() => {
              router.push(getNewAgentSessionPath(organizationId) as Href);
            }}
            onOpenFilters={() => {
              setShowFilterModal(true);
            }}
          />
        }
      />
      <Animated.View layout={LinearTransition}>
        <SessionFilterChips
          activeNow={activeNow}
          platformFilter={platformFilter}
          projectFilter={projectFilter}
          projectOptions={projectOptions}
          onRemoveActiveNow={() => {
            setActiveNow(false);
          }}
          onRemovePlatform={platform => {
            setPlatformFilter(prev => prev.filter(p => p !== platform));
          }}
          onRemoveProject={selectedGitUrl => {
            setProjectFilter(prev => prev.filter(gitUrlValue => gitUrlValue !== selectedGitUrl));
          }}
        />
      </Animated.View>
      <Animated.View layout={LinearTransition} className="flex-1">
        <AgentSessionListContent
          sections={sections}
          storedSessions={storedSessions}
          hasAnySessions={hasAnySessions}
          isLoading={isLoading || !ready}
          isSearchPending={isSearchPending}
          isError={contentIsError}
          isFetchingNextPage={isFetchingNextPage}
          refetch={handleRefetch}
          onRetry={handleRetry}
          onEndReached={handleEndReached}
          onSessionPress={navigateToSession}
          onSearchChange={handleSearchChange}
          hasActiveQuery={isSearching || hasActiveFilter}
          isSearching={isSearching}
          onClearQuery={handleClearQuery}
          onCreateSession={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
        />
      </Animated.View>
      {showFilterModal && (
        <SessionFilterModal
          selectedFilters={{ activeNow, platformFilter, projectFilter }}
          projectOptions={projectOptions}
          onClose={() => {
            setShowFilterModal(false);
          }}
          onApply={filters => {
            setFilters(filters);
          }}
        />
      )}
    </View>
  );
}
