import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useFocusEffect, useNavigation } from 'expo-router';

import { SessionFilterChips, SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { AgentSessionListContent } from '@/components/agents/session-list-content';
import { SessionListHeaderActions } from '@/components/agents/session-list-header-actions';
import { selectShowSearchBusy } from '@/components/agents/session-list-search-busy';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useAgentSessionListData } from '@/components/agents/use-agent-session-list-data';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { useSessionSearchInput } from '@/components/agents/use-session-search-input';
import { ScreenHeader } from '@/components/screen-header';
import { shouldLoadMoreSessions } from '@/lib/agent-session-pages';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { SESSION_FILTERS_KEY } from '@/lib/storage-keys';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useFencedDraftLoad } from '@/lib/persist/use-draft-load';
import { SESSION_SEARCH_DRAFT_KEY } from '@/lib/persist/drafts';
import { useOrganization } from '@/lib/organization-context';

const noopCreateSession = () => {
  // History owns no creation flow: the empty-state CTA is intentionally inert.
};

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
    setPlatformFilter,
    setProjectFilter,
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

  const ready = filtersLoaded && orgLoaded;

  const {
    storedSessions,
    activeSessionIds,
    storedIsFetching,
    storedLoadedPageCount,
    paging,
    handleRetry,
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
  useFocusEffect(
    useCallback(() => {
      void handleRefetchRef.current();
    }, [])
  );

  // App-foreground refresh for stored history. `navigation.isFocused()` is
  // read live because a frozen (unfocused) tab does not re-render. History
  // shows no tray, so only stored queries are touched.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && navigation.isFocused()) {
        void handleRefetchRef.current();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [navigation]);

  const navigateToSession = useAgentSessionNavigator();

  const handleEndReached = useCallback(() => {
    if (shouldLoadMoreSessions(paging)) {
      void paging.fetchNextPage();
    }
  }, [paging]);

  const hasActiveQuery = isSearching || activeFilterCount > 0;
  // History has no live tray, so "any sessions" means stored rows or an active
  // query — never the active set.
  const hasAnySessions = storedSessions.length > 0 || hasActiveQuery;

  // The inline error line only reflects content errors.
  const showInlineError = useMemo(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent: sections.length > 0,
        hasActiveQuery,
        isSearching,
        isError: contentIsError,
      }).showInlineError,
    [contentIsError, hasActiveQuery, isSearching, sections]
  );

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

  const isLoading =
    !ready || (isSearching ? search.isPending : storedIsFetching && storedLoadedPageCount === 0);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('tabs.agents')}
        showBackButton
        headerRight={
          <SessionListHeaderActions
            activeFilterCount={activeFilterCount}
            showNewSession={false}
            onNewSession={noopCreateSession}
            onOpenFilters={() => {
              setShowFilterModal(true);
            }}
          />
        }
      />
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
      <View className="flex-1">
        <AgentSessionListContent
          searchInputRef={searchInputRef}
          sections={sections}
          activeSessionIds={activeSessionIds}
          hasAnySessions={hasAnySessions}
          isLoading={isLoading}
          isError={contentIsError}
          isFetchingNextPage={paging.isFetchingNextPage}
          refetch={handleRefetch}
          onRetry={handleRetry}
          onEndReached={handleEndReached}
          onSessionPress={navigateToSession}
          hasActiveQuery={hasActiveQuery}
          isSearching={isSearching}
          searchQuery={searchQuery}
          onClearQuery={handleClearQuery}
          onCreateSession={noopCreateSession}
        />
      </View>
      {showFilterModal && (
        <SessionFilterModal
          selectedPlatforms={platformFilter}
          selectedProjects={projectFilter}
          projectOptions={projectOptions}
          onClose={() => {
            setShowFilterModal(false);
          }}
          onApply={setFilters}
        />
      )}
    </View>
  );
}
