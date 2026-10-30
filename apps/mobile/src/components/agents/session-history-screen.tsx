import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTranslation } from 'react-i18next';
import { useFocusEffect, useNavigation } from 'expo-router';

import { SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { AgentSessionListContent } from '@/components/agents/session-list-content';
import { SessionListHeader } from '@/components/agents/session-list-header';
import { selectSessionListIsLoading } from '@/components/agents/session-list-loading';
import { selectShowSearchBusy } from '@/components/agents/session-list-search-busy';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useAgentSessionListData } from '@/components/agents/use-agent-session-list-data';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useNewSessionNavigator } from '@/components/agents/use-new-session-navigator';
import { useSessionSearchInput } from '@/components/agents/use-session-search-input';
import { useOwnedKeyboard } from '@/components/agents/use-owned-keyboard';
import { shouldLoadMoreSessions } from '@/lib/agent-session-pages';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { SESSION_FILTERS_KEY } from '@/lib/storage-keys';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { SESSION_SEARCH_DRAFT_KEY } from '@/lib/persist/drafts';
import { useOrganization } from '@/lib/organization-context';

/**
 * Pushed sibling of the live Agents tab. Owns the stored session history with
 * search, filters, sort, and pagination, but never renders the live tray, the
 * new-session FAB, or any active-session surface.
 */
export function SessionHistoryScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();

  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const {
    platformFilter,
    projectFilter,
    activeFilterCount,
    hasLoaded: filtersLoaded,
    setFilters,
    clearFilters,
  } = usePersistedAgentSessionFilters(SESSION_FILTERS_KEY);
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
  const keyboard = useOwnedKeyboard();

  const ready = filtersLoaded && orgLoaded;

  const {
    storedSessions,
    activeSessionIds,
    storedIsPending,
    storedFetchedSinceMount,
    paging,
    handleRetry: retryHistory,
    handleRefetch,
    isSearching,
    search,
    projectOptions,
    contentIsError,
    sections,
  } = useAgentSessionListData({
    organizationId,
    platformFilter,
    projectFilter,
    ready,
    searchQuery,
  });

  const [isRetrying, setIsRetrying] = useState(false);
  const handleRetry = useCallback(() => {
    setIsRetrying(true);
    void (async () => {
      try {
        await retryHistory();
      } catch {
        setIsRetrying(false);
        return;
      }
      setIsRetrying(false);
    })();
  }, [retryHistory]);

  const showSearchBusy = selectShowSearchBusy({
    awaitingCommit,
    isSearching,
    isFetching: search.isFetching,
  });

  // Pushed-sibling focus refetch: fires on first push and on return from a
  // pushed detail screen, so a session that ended on the live tab appears in
  // history without a manual pull. Runs through the wrapped stored refetch.
  const handleRefetchRef = useRef(handleRefetch);
  useEffect(() => {
    handleRefetchRef.current = handleRefetch;
  }, [handleRefetch]);
  // Focus return and app-foreground refreshes run outside the pull lifecycle
  // (the pull state lives inside the content). Count each settlement so the
  // content can retire a stale pull-failure line once a later refresh lands;
  // persistent failures keep surfacing through the query error state.
  const [nonPullRefreshes, setNonPullRefreshes] = useState(0);
  const refetchOutsidePull = useCallback(() => {
    void (async () => {
      await handleRefetchRef.current();
      setNonPullRefreshes(count => count + 1);
    })();
  }, []);
  useFocusEffect(
    useCallback(() => {
      refetchOutsidePull();
    }, [refetchOutsidePull])
  );

  // App-foreground refresh for stored history. `navigation.isFocused()` is
  // read live because a frozen (unfocused) tab does not re-render. History
  // shows no tray, so only stored queries are touched.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && navigation.isFocused()) {
        refetchOutsidePull();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [navigation, refetchOutsidePull]);

  const navigateToSession = useAgentSessionNavigator();
  const { openNewSession } = useNewSessionNavigator();

  // The empty history's next step is a real session, in the current
  // organization: the same destination the Agents tab's "New session" action
  // opens, so history never dead-ends at a message.
  const handleCreateSession = useCallback(() => {
    openNewSession(organizationId);
  }, [openNewSession, organizationId]);

  const handleEndReached = useCallback(() => {
    if (shouldLoadMoreSessions(paging)) {
      void paging.fetchNextPage();
    }
  }, [paging]);

  const hasActiveQuery = isSearching || activeFilterCount > 0;
  // History has no live tray, so "any sessions" means stored rows or an active
  // query — never the active set.
  const hasAnySessions = storedSessions.length > 0 || hasActiveQuery;

  // The empty-state CTA reads "Clear search" or "Clear filters" depending on
  // isSearching, so it must clear exactly that. Clearing both under a label
  // naming one would silently drop the persisted filters.
  const handleClearQuery = useCallback(() => {
    if (isSearching) {
      clearSearchInput();
      searchController.clearSearchOnly();
      return;
    }
    clearFilters();
  }, [clearSearchInput, searchController, clearFilters, isSearching]);

  const isLoading = selectSessionListIsLoading({
    ready,
    isSearching,
    searchIsPending: search.isPending,
    storedIsPending,
  });

  // One permanently mounted body inside one keyboard container: the empty-state
  // subtitle, the rows, the skeletons and the reserved refresh band all lift
  // with the keyboard, so the no-match copy is never drawn half-behind it. The
  // container lives outside AgentSessionListContent's `FadeIn` early returns,
  // which mount after the keyboard is already up and would never read its
  // height (same contract as session-detail-content.tsx:1923-1931).
  const sessionListBody = (
    <AgentSessionListContent
      searchInputRef={searchInputRef}
      sections={sections}
      activeSessionIds={activeSessionIds}
      hasAnySessions={hasAnySessions}
      isLoading={isLoading}
      isError={contentIsError}
      hasFreshHistory={storedFetchedSinceMount}
      isFetchingNextPage={paging.isFetchingNextPage}
      refetch={handleRefetch}
      onRetry={handleRetry}
      onEndReached={handleEndReached}
      onSessionPress={navigateToSession}
      nonPullRefreshes={nonPullRefreshes}
      hasActiveQuery={hasActiveQuery}
      isSearching={isSearching}
      searchQuery={searchQuery}
      isRetrying={isRetrying}
      onClearQuery={handleClearQuery}
      onCreateSession={handleCreateSession}
    />
  );

  return (
    <View className="flex-1 bg-background">
      <SessionListHeader
        title={t('agents.sessionList.pastSessions')}
        showBackButton
        backFallback="/(app)/(tabs)/(2_agents)"
        searchOpen
        activeFilterCount={activeFilterCount}
        onOpenFilters={() => {
          Keyboard.dismiss();
          setShowFilterModal(true);
        }}
        search={
          <SessionListSearchHeader
            inputRef={searchInputRef}
            hasText={hasText}
            showSearchBusy={showSearchBusy}
            onChangeText={handleSearchInputChange}
            onClearSearch={handleClearSearchInput}
            onFocus={keyboard.handleInputFocus}
            onBlur={keyboard.handleInputBlur}
            defaultValue={searchDefaultValue}
            inputKey={searchInputKey}
            compact
            inline
          />
        }
      />
      <KeyboardAvoidingView className="flex-1" behavior="padding" enabled={keyboard.owned}>
        {sessionListBody}
      </KeyboardAvoidingView>
      <SessionFilterModal
        visible={showFilterModal}
        selectedPlatforms={platformFilter}
        selectedProjects={projectFilter}
        projectOptions={projectOptions}
        onClose={() => {
          setShowFilterModal(false);
        }}
        onApply={setFilters}
      />
    </View>
  );
}
