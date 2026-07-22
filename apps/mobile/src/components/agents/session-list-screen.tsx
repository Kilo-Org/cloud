import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { ActiveNowSection } from '@/components/agents/active-now-section';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { AgentSessionListContent } from '@/components/agents/session-list-content';
import { SessionListHeaderActions } from '@/components/agents/session-list-header-actions';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useSessionSearchInput } from '@/components/agents/use-session-search-input';
import {
  type ProjectFilterOption,
  SessionFilterChips,
  SessionFilterModal,
} from '@/components/agents/platform-filter-modal';
import {
  excludeActiveFromGroups,
  expandPlatformFilter,
  formatGitUrlProject,
  selectPinnedActiveSessions,
  type SessionSection,
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
    platformFilter,
    projectFilter,
    sortBy,
    hasLoaded: filtersLoaded,
    setFilters,
    setPlatformFilter,
    setProjectFilter,
  } = usePersistedAgentSessionFilters();
  const [showFilterModal, setShowFilterModal] = useState(false);

  const {
    searchQuery,
    searchInputRef,
    hasText,
    handleSearchInputChange,
    handleClearSearchInput,
    clearSearchInput,
    searchController,
  } = useSessionSearchInput();

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
    activeSessionIds,
    activeIsError,
    isLoading,
    storedIsError,
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

  // The body's error/empty state is driven only by the query that actually
  // fills the body: the search query while searching, otherwise the stored
  // (history) list. A transient active-poll blip must never fold into this —
  // it surfaces solely through the inline "Couldn't refresh" line via
  // `activeIsError`. Retrying still hits whichever query is really in error
  // instead of always refetching the base list underneath a failed search;
  // an active-only failure during search additionally retries the active poll
  // so the inline staleness line clears.
  const contentIsError = isSearching ? search.isError : storedIsError;
  const isSearchPending = isSearching && search.isPending;
  const searchRefetch = search.refetch;
  const handleRetry = useCallback(() => {
    if (!isSearching) {
      void refetch();
      return;
    }
    if (activeIsError) {
      // search is the body, active is the tray — retry both.
      void (async () => {
        await Promise.all([searchRefetch(), refetch()]);
      })();
      return;
    }
    void searchRefetch();
  }, [activeIsError, isSearching, refetch, searchRefetch]);

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

  // Pinned "Active now" tray. Free-text search is intentionally NOT a
  // narrowing input here — the tray persists while the user types. The
  // helper applies only the platform/project filters so the tray never
  // shows a session the user has explicitly filtered out.
  const pinnedActive = useMemo(
    () => selectPinnedActiveSessions({ activeSessions, projectFilter, platformFilter }),
    [activeSessions, platformFilter, projectFilter]
  );
  const hasPinnedActive = pinnedActive.length > 0;

  const organizationIdBySessionId = useMemo(
    () => new Map(storedSessions.map(s => [s.session_id, s.organization_id])),
    [storedSessions]
  );

  // History sections only. The pinned tray takes over for active sessions
  // and `excludeActiveFromGroups` keeps history exclusivity.
  const sections = useMemo<SessionSection[]>(() => {
    // Stored sessions are cursor-paginated, so a client-side filter would only
    // see the loaded pages. When a query is active, use the server search
    // results (which cover the full history) instead.
    const storedGroups = effectiveSearchQuery ? search.dateGroups : dateGroups;
    return excludeActiveFromGroups(storedGroups, activeSessionIds).map(group => ({
      title: group.label,
      data: group.sessions,
    }));
  }, [activeSessionIds, dateGroups, effectiveSearchQuery, search.dateGroups]);

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

  const hasActiveFilter = platformFilter.length > 0 || projectFilter.length > 0;
  const hasAnySessions = storedSessions.length > 0 || activeSessions.length > 0;

  // Search header is rendered at the screen level (above the pinned tray)
  // so it's always visible. Recompute the body's `showInlineError` here
  // via the SAME pure selector, with the same inputs, so the inline
  // "Couldn't refresh" line stays identical and the body-model test keeps
  // covering it.
  const showInlineError = useMemo(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent: sections.length > 0,
        hasPinnedActive,
        hasActiveQuery: isSearching || hasActiveFilter,
        isSearching,
        isError: contentIsError,
        activeIsError,
      }).showInlineError,
    [activeIsError, contentIsError, hasActiveFilter, hasPinnedActive, isSearching, sections]
  );

  const handleClearQuery = useCallback(() => {
    clearSearchInput();
    searchController.clearBroadly(setFilters);
  }, [clearSearchInput, searchController, setFilters]);

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
          platformFilter={platformFilter}
          projectFilter={projectFilter}
          projectOptions={projectOptions}
          onRemovePlatform={platform => {
            setPlatformFilter(prev => prev.filter(p => p !== platform));
          }}
          onRemoveProject={selectedGitUrl => {
            setProjectFilter(prev => prev.filter(gitUrlValue => gitUrlValue !== selectedGitUrl));
          }}
        />
      </Animated.View>
      {hasAnySessions ? (
        <SessionListSearchHeader
          inputRef={searchInputRef}
          hasText={hasText}
          isSearchPending={isSearchPending}
          showInlineError={showInlineError}
          onChangeText={handleSearchInputChange}
          onClearSearch={handleClearSearchInput}
        />
      ) : null}
      <ActiveNowSection
        pinned={pinnedActive}
        organizationIdBySessionId={organizationIdBySessionId}
        onSessionPress={navigateToSession}
      />
      <Animated.View layout={LinearTransition} className="flex-1">
        <AgentSessionListContent
          sections={sections}
          hasAnySessions={hasAnySessions}
          hasPinnedActive={hasPinnedActive}
          isLoading={isLoading || !ready}
          isError={contentIsError}
          activeIsError={activeIsError}
          isFetchingNextPage={isFetchingNextPage}
          refetch={handleRefetch}
          onRetry={handleRetry}
          onEndReached={handleEndReached}
          onSessionPress={navigateToSession}
          hasActiveQuery={isSearching || hasActiveFilter}
          isSearching={isSearching}
          onClearQuery={handleClearQuery}
          onCreateSession={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
          sortBy={sortBy}
        />
      </Animated.View>
      {showFilterModal && (
        <SessionFilterModal
          selectedPlatforms={platformFilter}
          selectedProjects={projectFilter}
          selectedSortBy={sortBy}
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
