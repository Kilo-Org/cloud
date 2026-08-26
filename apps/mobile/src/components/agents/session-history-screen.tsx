import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

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
    sortBy,
    ready,
    searchQuery,
  });

  const showSearchBusy = selectShowSearchBusy({
    awaitingCommit,
    isSearching,
    isFetching: search.isFetching,
  });

  const navigateToSession = useAgentSessionNavigator();

  const handleEndReached = useCallback(() => {
    if (shouldLoadMoreSessions(paging)) {
      void paging.fetchNextPage();
    }
  }, [paging]);

  const hasActiveFilter = platformFilter.length > 0 || projectFilter.length > 0;
  const hasActiveQuery = isSearching || hasActiveFilter;
  // History has no live tray, so "any sessions" means stored rows or an active
  // query — never the active set.
  const hasAnySessions = storedSessions.length > 0 || hasActiveQuery;

  // Same pure selector as the live screen, but the history view never feeds
  // the active-set flags: the inline error line only reflects content errors.
  const showInlineError = useMemo(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent: sections.length > 0,
        hasStoredSessions: storedSessions.length > 0,
        hasMoreHistory: paging.hasNextPage,
        hasPinnedActive: false,
        hasActiveQuery,
        isSearching,
        isError: contentIsError,
        activeIsError: false,
      }).showInlineError,
    [contentIsError, hasActiveQuery, isSearching, paging.hasNextPage, sections, storedSessions]
  );

  const handleClearQuery = useCallback(() => {
    clearSearchInput();
    searchController.clearBroadly(setFilters);
  }, [clearSearchInput, searchController, setFilters]);

  const isLoading =
    !ready || (isSearching ? search.isPending : storedIsFetching && storedLoadedPageCount === 0);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('tabs.agents')}
        showBackButton
        headerRight={
          <SessionListHeaderActions
            hasActiveFilter={hasActiveFilter}
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
          hasAnySessions={hasAnySessions}
          hasPinnedActive={false}
          isLoading={isLoading}
          isError={contentIsError}
          activeIsError={false}
          hasStoredSessions={storedSessions.length > 0}
          hasMoreHistory={paging.hasNextPage}
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
          sortBy={sortBy}
          activeNowSection={null}
        />
      </View>
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
