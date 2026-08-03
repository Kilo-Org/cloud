/* eslint-disable max-lines */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus } from 'lucide-react-native';

import { ActiveNowSection } from '@/components/agents/active-now-section';
import { DiagnosticsIndicator } from '@/components/agents/diagnostics-indicator';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { selectSessionListContentSurface } from '@/components/agents/session-list-content-surface';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import {
  AgentSessionListContent,
  FAB_MARGIN,
  FAB_SIZE,
} from '@/components/agents/session-list-content';
import { SessionListHeaderActions } from '@/components/agents/session-list-header-actions';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useSessionSearchInput } from '@/components/agents/use-session-search-input';
import { SessionFilterChips, SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { selectShowSearchBusy } from '@/components/agents/session-list-search-busy';
import { useAgentSessionListData } from '@/components/agents/use-agent-session-list-data';
import { ScreenHeader } from '@/components/screen-header';
import { captureEvent, LIST_DIAGNOSTICS_EVENT } from '@/lib/analytics/posthog';
import { useDiagnosticsWindow } from '@/lib/hooks/use-diagnostics-window';
import {
  buildAgentsListDiagnostics,
  buildDiagnosticsSignature,
  shouldCaptureDiagnostics,
} from '@/lib/list-diagnostics';
import { usePersistedAgentSessionFilters } from '@/lib/hooks/use-persisted-agent-session-filters';
import { useOrganization } from '@/lib/organization-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

import { type Href, useFocusEffect, useRouter } from 'expo-router';

export function AgentSessionListScreen() {
  const router = useRouter();
  const colors = useThemeColors();
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

  const {
    searchQuery,
    searchInputRef,
    hasText,
    awaitingCommit,
    handleSearchInputChange,
    handleClearSearchInput,
    clearSearchInput,
    searchController,
  } = useSessionSearchInput();

  const ready = filtersLoaded && orgLoaded;

  // D4 — diagnostics window (flag × consent × active time range).
  const diagnosticsActive = useDiagnosticsWindow();

  // Navigation guard: prevent double-push on rapid row taps. Re-arms on next focus.
  const rowNavLockRef = useRef(false);

  const {
    storedSessions,
    activeSessions,
    activeIsError,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
    handleRetry,
    handleRefetch,
    isSearching,
    search,
    projectOptions,
    contentIsError,
    storedIsError,
    storedIsLoading,
    activeIsLoading,
    storedErrorCode,
    pageCount,
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
      rowNavLockRef.current = false;
      void refetchRef.current();
    }, [])
  );

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

  const navigateToSession = useCallback(
    (sessionId: string, sessionOrgId?: string | null) => {
      if (rowNavLockRef.current) {
        return;
      }
      rowNavLockRef.current = true;
      try {
        router.push(
          (sessionOrgId
            ? `/(app)/agent-chat/${sessionId}?organizationId=${sessionOrgId}`
            : `/(app)/agent-chat/${sessionId}`) as Href
        );
      } catch {
        rowNavLockRef.current = false;
      }
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

  // Inline error recomputed here (same pure selector, same inputs) so the
  // body-model test continues covering it.
  const bodyModel = useMemo(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent: sections.length > 0,
        hasPinnedActive,
        hasActiveQuery: isSearching || hasActiveFilter,
        isSearching,
        isError: contentIsError,
        activeIsError,
      }),
    [activeIsError, contentIsError, hasActiveFilter, hasPinnedActive, isSearching, sections]
  );
  const showInlineError = bodyModel.showInlineError;
  const surface = useMemo(
    () =>
      selectSessionListContentSurface({
        isLoading: isLoading || !ready,
        isError: contentIsError,
        hasAnySessions,
        hasPinnedActive,
        hasHistoryContent: sections.length > 0,
      }),
    [contentIsError, hasAnySessions, hasPinnedActive, isLoading, ready, sections]
  );

  // D4 — diagnostics capture (payload, dedup, under-cap guard).
  const diagnostics = useMemo(
    () =>
      buildAgentsListDiagnostics({
        surface: surface.kind,
        list_empty: surface.kind === 'section-list' ? surface.listEmpty : 'none',
        body_kind: bodyModel.kind,
        order_by: sortBy,
        // The limit of the query that produced the rows: 30 for the list
        // (SESSIONS_PAGE_SIZE, agent-session-input.ts:24), 50 for search
        // (buildAgentSessionSearchInput, agent-session-input.ts:70).
        page_size: isSearching ? 50 : 30,
        // Loaded pages of the stored list query. The search query is not
        // paged, so it reports 0 and `page_size` carries the search limit.
        page_count: isSearching ? 0 : pageCount,
        // `hasNextPage` is `boolean | undefined` — explicit check is deliberate.
        // eslint-disable-next-line typescript-eslint/no-unnecessary-boolean-literal-compare
        has_next_page: hasNextPage === true,
        has_organization: organizationId != null,
        // eslint-disable-next-line unicorn/no-array-sort -- Hermes has no toSorted
        platform_filter: [...platformFilter].sort().join(','),
        project_filter_count: projectFilter.length,
        is_searching: isSearching,
        search_query_length: searchQuery.length,
        stored_count: storedSessions.length,
        active_count: activeSessions.length,
        pinned_count: pinnedActive.length,
        section_count: sections.length,
        row_count: sections.reduce((total, section) => total + section.data.length, 0),
        has_any_sessions: hasAnySessions,
        ready,
        filters_loaded: filtersLoaded,
        org_loaded: orgLoaded,
        // The EFFECTIVE loading flag, identical to the value the body gets at
        // line 223. The raw query bits follow, so `ready=false` with both raw
        // bits false is distinguishable from a query that never settles.
        is_loading: isLoading || !ready,
        stored_is_loading: storedIsLoading,
        active_is_loading: activeIsLoading,
        stored_is_error: storedIsError,
        active_is_error: activeIsError,
        search_is_error: search.isError,
        stored_error_code: storedErrorCode,
      }),
    [
      activeIsError,
      activeIsLoading,
      activeSessions.length,
      bodyModel.kind,
      filtersLoaded,
      hasAnySessions,
      hasNextPage,
      isLoading,
      isSearching,
      orgLoaded,
      organizationId,
      pageCount,
      pinnedActive.length,
      platformFilter,
      projectFilter.length,
      ready,
      search.isError,
      searchQuery.length,
      sections,
      sortBy,
      storedErrorCode,
      storedIsError,
      storedIsLoading,
      storedSessions.length,
      surface,
    ]
  );
  const lastSignatureRef = useRef<string | null>(null);
  const sentCountRef = useRef(0);
  useEffect(() => {
    // Re-arm on every off transition so a second window in the same launch
    // reports the current state again instead of deduping against the first.
    if (!diagnosticsActive) {
      lastSignatureRef.current = null;
      return;
    }
    const signature = buildDiagnosticsSignature(diagnostics);
    if (
      !shouldCaptureDiagnostics({
        active: diagnosticsActive,
        signature,
        lastSignature: lastSignatureRef.current,
        sentCount: sentCountRef.current,
      })
    ) {
      return;
    }
    lastSignatureRef.current = signature;
    sentCountRef.current += 1;
    captureEvent(LIST_DIAGNOSTICS_EVENT, diagnostics);
  }, [diagnostics, diagnosticsActive]);

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
      {diagnosticsActive && <DiagnosticsIndicator />}
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
        />
      ) : null}
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
          accessibilityLabel="New session"
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
