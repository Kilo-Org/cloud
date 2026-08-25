import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Plus } from '@/components/ui/icons';

import { ActiveNowSection } from '@/components/agents/active-now-section';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import {
  AgentSessionListContent,
  FAB_MARGIN,
  FAB_SIZE,
} from '@/components/agents/session-list-content';
import { SessionListHeaderActions } from '@/components/agents/session-list-header-actions';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useSessionSearchInput } from '@/components/agents/use-session-search-input';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { SessionFilterChips, SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { selectShowSearchBusy } from '@/components/agents/session-list-search-busy';
import { useAgentSessionListData } from '@/components/agents/use-agent-session-list-data';
import { shouldLoadMoreSessions } from '@/lib/agent-session-pages';
import { ScreenHeader } from '@/components/screen-header';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { SESSION_SEARCH_DRAFT_KEY } from '@/lib/persist/drafts';
import { useOrganization } from '@/lib/organization-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

import { type Href, useFocusEffect, useNavigation, useRouter } from 'expo-router';

export function AgentSessionListScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();

  const tabBarHeight = useMemo(
    () => getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale }),
    [bottom, fontScale]
  );

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

  // Durable session-list search draft. The input mounts immediately — typing
  // never waits on the account query — and the stored draft settles behind it
  // (same pattern as the new-session prompt draft in agent-chat/new.tsx).
  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const searchDraftState = useFencedDraftLoad({
    userId,
    isIdentityLoading,
    entityKey: SESSION_SEARCH_DRAFT_KEY,
  });

  const {
    searchQuery,
    searchInputRef,
    hasText,
    awaitingCommit,
    handleSearchInputChange,
    handleClearSearchInput,
    clearSearchInput,
    searchController,
    searchInputKey,
    searchDefaultValue,
  } = useSessionSearchInput({
    userId,
    restoredQuery: searchDraftState.value,
    restoreSettled: searchDraftState.settled,
  });

  const ready = filtersLoaded && orgLoaded;

  const {
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
  } = useAgentSessionListData({
    organizationId,
    platformFilter,
    projectFilter,
    sortBy,
    ready,
    searchQuery,
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

  // App-foreground refresh for the Agents list. The stored query opts out of
  // React Query's native window-focus refetch (`refetchOnWindowFocus: false`
  // from the list hook), so an OS foreground transition must be driven here —
  // through the same wrapped `refetch` as navigation focus — to keep every
  // stored refetch serialized by the shared operation coordinator (backfill
  // and departure never overlap a refetch). A frozen (unfocused) Agents tab
  // must NOT refetch on foreground: only the focused tab refreshes the stored
  // list and invalidates the active-sessions tray. Focus is read live via
  // `navigation.isFocused()` because a frozen tree does not re-render.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && navigation.isFocused()) {
        void refetchRef.current();
        void queryClient.invalidateQueries({ queryKey: [['activeSessions']] });
      }
    });
    return () => {
      subscription.remove();
    };
  }, [queryClient, navigation]);

  const showSearchBusy = selectShowSearchBusy({
    awaitingCommit,
    isSearching,
    isFetching: search.isFetching,
  });

  const hasPinnedActive = pinnedActive.length > 0;

  const organizationIdBySessionId = useMemo(
    () => new Map(storedSessions.map(s => [s.session_id, s.organization_id])),
    [storedSessions]
  );

  const navigateToSession = useAgentSessionNavigator();

  const handleEndReached = useCallback(() => {
    if (shouldLoadMoreSessions(paging)) {
      void paging.fetchNextPage();
    }
  }, [paging]);

  const hasActiveFilter = platformFilter.length > 0 || projectFilter.length > 0;
  const hasAnySessions = storedSessions.length > 0 || activeSessions.length > 0;

  // Inline error recomputed here (same pure selector, same inputs) so the
  // body-model test continues covering it.
  const showInlineError = useMemo(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent: sections.length > 0,
        hasStoredSessions: storedSessions.length > 0,
        hasMoreHistory: paging.hasNextPage,
        hasPinnedActive,
        hasActiveQuery: isSearching || hasActiveFilter,
        isSearching,
        isError: contentIsError,
        activeIsError,
      }).showInlineError,
    [
      activeIsError,
      contentIsError,
      hasActiveFilter,
      hasPinnedActive,
      isSearching,
      paging.hasNextPage,
      sections,
      storedSessions,
    ]
  );

  const handleClearQuery = useCallback(() => {
    clearSearchInput();
    searchController.clearBroadly(setFilters);
  }, [clearSearchInput, searchController, setFilters]);

  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: 20,
      width: FAB_SIZE,
      height: FAB_SIZE,
    }),
    [tabBarHeight]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('tabs.agents')}
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
          showSearchBusy={showSearchBusy}
          showInlineError={showInlineError}
          onChangeText={handleSearchInputChange}
          onClearSearch={handleClearSearchInput}
          defaultValue={searchDefaultValue}
          inputKey={searchInputKey}
        />
      ) : null}
      <Animated.View layout={LinearTransition} className="flex-1">
        <AgentSessionListContent
          searchInputRef={searchInputRef}
          sections={sections}
          hasAnySessions={hasAnySessions}
          hasPinnedActive={hasPinnedActive}
          isLoading={isLoading || !ready}
          isError={contentIsError}
          activeIsError={activeIsError}
          hasStoredSessions={storedSessions.length > 0}
          hasMoreHistory={paging.hasNextPage}
          isFetchingNextPage={paging.isFetchingNextPage}
          refetch={handleRefetch}
          onRetry={handleRetry}
          onEndReached={handleEndReached}
          onSessionPress={navigateToSession}
          hasActiveQuery={isSearching || hasActiveFilter}
          isSearching={isSearching}
          searchQuery={searchQuery}
          onClearQuery={handleClearQuery}
          onCreateSession={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
          sortBy={sortBy}
          activeNowSection={
            <ActiveNowSection
              pinned={pinnedActive}
              organizationIdBySessionId={organizationIdBySessionId}
              onSessionPress={navigateToSession}
            />
          }
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
      {/* FAB visible when there are sessions — empty state already owns the creation CTA. */}
      {hasAnySessions && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.newSession.title')}
          testID="agents-new-session-fab"
          onPress={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
          className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-black/25 active:opacity-80"
          style={fabStyle}
        >
          <Plus size={24} color={colors.primaryForeground} />
        </Pressable>
      )}
    </View>
  );
}
