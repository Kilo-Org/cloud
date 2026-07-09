import { Plus, SlidersHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { AgentSessionListContent } from '@/components/agents/session-list-content';
import {
  type ProjectFilterOption,
  SessionFilterChips,
  SessionFilterModal,
} from '@/components/agents/platform-filter-modal';
import {
  expandPlatformFilter,
  formatGitUrlProject,
  matchesSearch,
  type RemoteSessionItem,
  type SessionSection,
  type StoredSessionItem,
} from '@/components/agents/session-list-helpers';
import { ScreenHeader } from '@/components/screen-header';
import {
  useAgentSessions,
  useAgentSessionSearch,
  useRecentAgentRepositories,
} from '@/lib/hooks/use-agent-sessions';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';

import { type Href, useFocusEffect, useRouter } from 'expo-router';

export function AgentSessionListScreen() {
  const router = useRouter();
  const colors = useThemeColors();

  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const {
    platformFilter,
    projectFilter,
    hasLoaded: filtersLoaded,
    setFilters,
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
    activeSessionIds,
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

  const sections = useMemo<SessionSection[]>(() => {
    const result: SessionSection[] = [];
    const storedSessionIds = new Set(storedSessions.map(session => session.session_id));

    const filteredActive = activeSessions.filter(session => {
      if (storedSessionIds.has(session.id)) {
        return false;
      }

      if (projectFilter.length > 0 && !session.gitUrl) {
        return false;
      }

      if (projectFilter.length > 0 && session.gitUrl && !projectFilter.includes(session.gitUrl)) {
        return false;
      }

      return searchQuery ? matchesSearch(searchQuery, session.title, session.gitUrl ?? null) : true;
    });

    if (filteredActive.length > 0) {
      result.push({
        title: 'Remote',
        data: filteredActive.map(
          (session): RemoteSessionItem => ({
            kind: 'remote',
            session,
          })
        ),
      });
    }

    // Stored sessions are cursor-paginated, so a client-side filter would only
    // see the loaded pages. When a query is active, use the server search
    // results (which cover the full history) instead.
    const storedGroups = searchQuery ? search.dateGroups : dateGroups;
    for (const group of storedGroups) {
      if (group.sessions.length > 0) {
        result.push({
          title: group.label,
          data: group.sessions.map(
            (session): StoredSessionItem => ({
              kind: 'stored',
              session,
              isLive: activeSessionIds.has(session.session_id),
            })
          ),
        });
      }
    }

    return result;
  }, [
    activeSessionIds,
    activeSessions,
    dateGroups,
    projectFilter,
    search.dateGroups,
    searchQuery,
    storedSessions,
  ]);

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

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Agents"
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={
          <View className="flex-row items-center gap-4">
            <Pressable
              onPress={() => {
                router.push(getNewAgentSessionPath(organizationId) as Href);
              }}
              // right slop capped so the expanded targets don't overlap inside the 16px gap
              hitSlop={{ top: 11, bottom: 11, left: 11, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="New session"
              className="active:opacity-70"
            >
              <Plus size={22} color={colors.foreground} />
            </Pressable>
            <Pressable
              onPress={() => {
                setShowFilterModal(true);
              }}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 12 }}
              accessibilityRole="button"
              accessibilityLabel="Filter sessions"
              className="active:opacity-70"
            >
              <SlidersHorizontal
                size={20}
                color={hasActiveFilter ? colors.foreground : colors.mutedForeground}
              />
            </Pressable>
          </View>
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
      <Animated.View layout={LinearTransition} className="flex-1">
        <AgentSessionListContent
          sections={sections}
          storedSessions={storedSessions}
          hasAnySessions={storedSessions.length > 0 || activeSessions.length > 0}
          isLoading={isLoading || !ready || (isSearching && search.isPending)}
          isError={isError || (isSearching && search.isError)}
          isFetchingNextPage={isFetchingNextPage}
          refetch={refetch}
          onEndReached={handleEndReached}
          onSessionPress={navigateToSession}
          onSearchChange={handleSearchChange}
          onCreateSession={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
        />
      </Animated.View>
      {showFilterModal && (
        <SessionFilterModal
          selectedPlatforms={platformFilter}
          selectedProjects={projectFilter}
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
