import { Plus, Search, SlidersHorizontal } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

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
import { ProfileAvatarButton } from '@/components/profile-avatar-button';
import { ScreenHeader } from '@/components/screen-header';
import { useAgentSessions, useRecentAgentRepositories } from '@/lib/hooks/use-agent-sessions';
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
    refetch,
  } = useAgentSessions({
    createdOnPlatform,
    gitUrl,
    organizationId,
    enabled: ready,
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

    for (const group of dateGroups) {
      const filteredSessions = searchQuery
        ? group.sessions.filter(s => matchesSearch(searchQuery, s.title, s.git_url))
        : group.sessions;

      if (filteredSessions.length > 0) {
        result.push({
          title: group.label,
          data: filteredSessions.map(
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
  }, [activeSessionIds, activeSessions, dateGroups, projectFilter, searchQuery, storedSessions]);

  const navigateToSession = useCallback(
    (sessionId: string, sessionOrgId?: string | null) => {
      const path = sessionOrgId
        ? `/(app)/agent-chat/${sessionId}?organizationId=${sessionOrgId}`
        : `/(app)/agent-chat/${sessionId}`;
      router.push(path as Href);
    },
    [router]
  );

  const hasActiveFilter = platformFilter.length > 0 || projectFilter.length > 0;

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title="Agents"
        showBackButton={false}
        headerRight={
          <View className="flex-row items-center gap-4">
            <Pressable
              onPress={() => {
                const path = organizationId
                  ? `/(app)/agent-chat/new?organizationId=${organizationId}`
                  : '/(app)/agent-chat/new';
                router.push(path as Href);
              }}
              hitSlop={8}
              accessibilityLabel="New session"
            >
              <Plus size={22} color={colors.foreground} />
            </Pressable>
            <Pressable
              onPress={() => {
                setShowFilterModal(true);
              }}
              hitSlop={8}
              accessibilityLabel="Filter sessions"
            >
              <SlidersHorizontal
                size={20}
                color={hasActiveFilter ? colors.foreground : colors.mutedForeground}
              />
            </Pressable>
            <ProfileAvatarButton />
          </View>
        }
      />
      <View className="mx-4 my-2 flex-row items-center gap-2 rounded-lg bg-secondary px-3 py-2">
        <Search size={16} color={colors.mutedForeground} />
        <TextInput
          className="flex-1 text-sm leading-5 text-foreground"
          placeholder="Search sessions..."
          placeholderTextColor={colors.mutedForeground}
          onChangeText={handleSearchChange}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
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
          isLoading={isLoading || !ready}
          isError={isError}
          refetch={refetch}
          onSessionPress={navigateToSession}
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
