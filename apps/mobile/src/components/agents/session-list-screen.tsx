import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AppState,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Bot, Plus } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import {
  liveSessionContent,
  LiveSessionFeedback,
  useLiveSessionContext,
} from '@/components/home/agent-sessions-section';
import { LiveSessionListEmptyState } from '@/components/agents/live-session-list-empty-state';
import { SessionFilterChips, SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { SessionFilterButton } from '@/components/agents/session-filter-button';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
import { useLiveSessionQuery } from '@/components/agents/use-live-session-query';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ContextControl } from '@/components/context-control';
import { ScreenHeader } from '@/components/screen-header';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';
import { type ActiveSession, useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';

import { type Href, useFocusEffect, useNavigation, useRouter, useScrollToTop } from 'expo-router';

const SKELETON_ROW_COUNT = 8;

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

  const context = useLiveSessionContext();
  const { organizationId } = context;
  const sessions = useLiveAgentSessions({ organizationId, enabled: context.isReady });
  const { activeSessions, refetch } = sessions;
  const content = liveSessionContent(context, sessions);
  const hasLiveRows = content === 'rows';

  const query = useLiveSessionQuery(activeSessions);
  const { visibleSessions, isSearching } = query;
  const [showFilterModal, setShowFilterModal] = useState(false);
  const hasVisibleRows = visibleSessions.length > 0;

  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);
  useFocusEffect(
    useCallback(() => {
      void refetchRef.current();
    }, [])
  );

  const listRef = useRef<FlatList<ActiveSession>>(null);
  useScrollToTop(listRef);

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the live Agents list is frozen. On return, each row re-reads the
  // ack store via its own `useSyncExternalStore` subscription
  // (`useSessionAttentionRevision`). Snapshot the attention revision when the
  // tab (re)gains focus via `useFocusEffect` (fires after unfreeze) and pass
  // it as `extraData` so visible cells re-render without remounting the list —
  // preserving scroll.
  const [attentionFocusRevision, setAttentionFocusRevision] = useState(getRevisionSnapshot);
  useFocusEffect(
    useCallback(() => {
      setAttentionFocusRevision(getRevisionSnapshot());
    }, [])
  );

  // Preserve the focused foreground refresh and the active-sessions tray invalidation.
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

  const navigateToSession = useAgentSessionNavigator();

  const seeAllLabel = t('home.seeAll');
  const headerRight = (
    <View className="min-h-11 min-w-0 flex-row items-center gap-4">
      <Pressable
        onPress={() => {
          router.push('/(app)/(tabs)/(2_agents)/history' as Href);
        }}
        // left slop capped against the large title, right slop reaches 44pt wide
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
        accessibilityRole="button"
        accessibilityLabel={seeAllLabel}
        testID="agents-view-history"
        className="min-w-0 shrink justify-center active:opacity-70"
      >
        <Text className="shrink text-center font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          {seeAllLabel}
        </Text>
      </Pressable>
      {query.canFilter ? (
        <SessionFilterButton
          activeCount={query.activeFilterCount}
          onPress={() => {
            setShowFilterModal(true);
          }}
          testID="agents-open-filters"
        />
      ) : null}
    </View>
  );

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        // LiveSessionFeedback retains and announces failures without a duplicate toast.
        await refetch();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch]);

  const renderItem = useCallback(
    ({ item }: { item: ActiveSession }) => (
      <RemoteSessionRow
        session={item}
        onPress={() => {
          navigateToSession(item.id, organizationId);
        }}
      />
    ),
    [navigateToSession, organizationId]
  );

  const keyExtractor = useCallback((item: ActiveSession) => item.id, []);

  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it. The FAB adds its own inset when it shows so the last row
  // scrolls clear of the button too. paddingTop merges here (not a className)
  // to match the historical first-row inset without a separate wrapper.
  const listPadding = useMemo(
    () => ({
      paddingTop: 18,
      paddingBottom: tabBarHeight + (hasLiveRows ? FAB_SIZE + FAB_MARGIN : 0),
    }),
    [tabBarHeight, hasLiveRows]
  );

  const fabStyle = useMemo(
    () => ({
      bottom: tabBarHeight + FAB_MARGIN,
      right: 20,
      width: FAB_SIZE,
      height: FAB_SIZE,
    }),
    [tabBarHeight]
  );

  let body: ReactNode = null;
  if (!query.hasLoaded || content === 'pending') {
    body = (
      <View className="pt-[18px]">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <View key={i} className="py-1.5">
            <Skeleton className="mx-[22px] h-[76px] rounded-none" />
          </View>
        ))}
      </View>
    );
  } else if (hasLiveRows && !hasVisibleRows) {
    body = (
      <EmptyState
        icon={Bot}
        title={t('agents.sessionList.noMatches')}
        description={
          isSearching
            ? t('agents.sessionList.tryDifferentSearch')
            : t('agents.sessionList.tryAdjustFilters')
        }
        action={
          <Button
            variant="outline"
            onPress={isSearching ? query.handleClearSearch : query.handleClearFilters}
          >
            <Text>
              {isSearching ? t('agents.search.clearSearch') : t('agents.search.clearFilters')}
            </Text>
          </Button>
        }
      />
    );
  } else if (content === 'empty') {
    body = (
      <LiveSessionListEmptyState organizationId={organizationId} tabBarHeight={tabBarHeight} />
    );
  } else if (hasLiveRows) {
    body = (
      <FlatList
        ref={listRef}
        data={visibleSessions}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={attentionFocusRevision}
        contentContainerStyle={listPadding}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 10 }}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('tabs.agents')}
        eyebrow={
          !sessions.isLoading && !sessions.isError && (hasLiveRows || content === 'empty')
            ? t('agents.liveCount', { count: activeSessions.length })
            : undefined
        }
        reserveEyebrow
        size="large"
        showBackButton={false}
        className="px-[22px] pb-0"
        headerRight={headerRight}
      />
      <View className="px-[22px]">
        <View className="min-h-11 items-end">
          <ContextControl
            showOrganizationName={context.isReady}
            scope={context.accountReady ? undefined : { organizationId: null, isResolved: false }}
          />
        </View>
        <LiveSessionFeedback
          context={context}
          sessions={sessions}
          failureLabel={t('agents.sessionList.couldNotLoadActive')}
        />
      </View>
      {hasLiveRows || isSearching ? (
        <SessionListSearchHeader
          inputRef={query.searchInputRef}
          hasText={query.searchQuery.length > 0}
          showSearchBusy={false}
          showInlineError={false}
          onChangeText={query.handleSearchChange}
          onClearSearch={query.handleClearSearch}
        />
      ) : null}
      <SessionFilterChips
        platformFilter={query.platformFilter}
        projectFilter={query.projectFilter}
        projectOptions={query.options.projectOptions}
        onRemovePlatform={query.handleRemovePlatform}
        onRemoveProject={query.handleRemoveProject}
      />
      {body}
      {/* Empty content owns its creation action; other admitted states keep the FAB. */}
      {context.isReady && content !== 'empty' && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.newSession.title')}
          testID="agents-new-session-fab"
          onPress={() => {
            router.push(getNewAgentSessionPath(organizationId) as Href);
          }}
          className="absolute items-center justify-center rounded-full bg-primary shadow-lg shadow-[#00000040] active:opacity-80"
          style={fabStyle}
        >
          <Plus size={24} color={colors.primaryForeground} />
        </Pressable>
      )}
      {showFilterModal && (
        <SessionFilterModal
          selectedPlatforms={query.platformFilter}
          selectedProjects={query.projectFilter}
          projectOptions={query.options.projectOptions}
          platformOptions={query.options.platformOptions}
          onClose={() => {
            setShowFilterModal(false);
          }}
          onApply={query.handleApplyFilters}
        />
      )}
    </View>
  );
}
