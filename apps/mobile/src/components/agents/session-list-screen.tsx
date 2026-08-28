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
import { Bot, Plus, SlidersHorizontal } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import {
  buildLiveFilterOptions,
  filterLiveSessions,
} from '@/components/agents/live-session-filters';
import { SessionFilterChips, SessionFilterModal } from '@/components/agents/platform-filter-modal';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { RemoteSessionRow } from '@/components/agents/remote-session-row';
import { FAB_MARGIN, FAB_SIZE } from '@/components/agents/session-list-content';
import { useAgentSessionNavigator } from '@/components/agents/use-agent-session-navigator';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useOrganization } from '@/lib/organization-context';
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

  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  const { activeSessions, isLoading, isError, refetch } = useLiveAgentSessions({
    organizationId,
    enabled: orgLoaded,
  });

  // Repository and origin filters for the live list. The whole live set is
  // already in memory, so filtering is local — no refetch, no extra query.
  // Kept in component state rather than the persisted history filters: the two
  // screens show different rows, and a filter hidden behind an app restart
  // would silently hide running sessions.
  const [platformFilter, setPlatformFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);
  const [showFilterModal, setShowFilterModal] = useState(false);

  const filterOptions = useMemo(() => buildLiveFilterOptions(activeSessions), [activeSessions]);
  const visibleSessions = useMemo(
    () => filterLiveSessions(activeSessions, platformFilter, projectFilter),
    [activeSessions, platformFilter, projectFilter]
  );

  const hasActiveFilter = platformFilter.length > 0 || projectFilter.length > 0;
  const clearFilters = useCallback(() => {
    setPlatformFilter([]);
    setProjectFilter([]);
  }, []);

  // Treat !orgLoaded as loading so the empty state cannot flash before skeletons.
  const loading = isLoading || !orgLoaded;
  const hasLiveRows = activeSessions.length > 0;
  const hasVisibleRows = visibleSessions.length > 0;
  // Only offer the picker when there is something to pick, and keep it while a
  // filter is applied so the user can always get back to the full list.
  const showFilterButton =
    hasActiveFilter ||
    filterOptions.projectOptions.length + filterOptions.platformOptions.length > 0;

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

  // App-foreground refresh for the live Agents list. The live query keeps its
  // own poll interval; an OS foreground transition re-reads focus live via
  // `navigation.isFocused()` because a frozen (unfocused) tab does not
  // re-render. Only the focused tab refetches live sessions and invalidates
  // the active-sessions tray — no stored queries are touched.
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
    <View className="flex-row items-center gap-4">
      <Pressable
        onPress={() => {
          router.push('/(app)/(tabs)/(2_agents)/history' as Href);
        }}
        // left slop capped against the large title, right slop reaches 44pt wide
        hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
        accessibilityRole="button"
        accessibilityLabel={seeAllLabel}
        testID="agents-view-history"
        className="active:opacity-70"
      >
        <Text className="shrink font-mono-medium text-[11px] uppercase tracking-[1.5px] text-primary">
          {seeAllLabel}
        </Text>
      </Pressable>
      {showFilterButton ? (
        <Pressable
          onPress={() => {
            setShowFilterModal(true);
          }}
          // left slop capped against the 16px gap, right slop reaches 44pt wide
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 16 }}
          accessibilityRole="button"
          accessibilityLabel={t('agentChat.sessionFilter.title')}
          testID="agents-open-filters"
          className="active:opacity-70"
        >
          <SlidersHorizontal
            size={20}
            color={hasActiveFilter ? colors.foreground : colors.mutedForeground}
          />
        </Pressable>
      ) : null}
    </View>
  );

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        const ok = await refetch();
        if (!ok && hasLiveRows) {
          announcingToast.error(t('common.couldNotRefresh'));
        }
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch, hasLiveRows, t]);

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
  if (loading && !hasLiveRows) {
    body = (
      <View className="pt-[18px]">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <View key={i} className="py-1.5">
            <Skeleton className="mx-[22px] h-[76px] rounded-none" />
          </View>
        ))}
      </View>
    );
  } else if (isError && !hasLiveRows) {
    body = (
      <QueryError
        message={t('agents.sessionList.couldNotLoadActive')}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  } else if (hasLiveRows && !hasVisibleRows) {
    body = (
      <EmptyState
        icon={Bot}
        title={t('agents.sessionList.noMatches')}
        description={t('agents.sessionList.tryAdjustFilters')}
        action={
          <Button variant="outline" onPress={clearFilters}>
            <Text>{t('agents.search.clearFilters')}</Text>
          </Button>
        }
      />
    );
  } else if (!hasLiveRows) {
    body = (
      <EmptyState
        icon={Bot}
        title={t('home.noLiveSessions')}
        description={t('agents.sessionList.noSessionsYetDescription')}
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.push(getNewAgentSessionPath(organizationId) as Href);
            }}
          >
            <Plus size={16} color={colors.foreground} />
            <Text>{t('home.newCodingTask')}</Text>
          </Button>
        }
      />
    );
  } else {
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
        size="large"
        showBackButton={false}
        className="px-[22px]"
        headerRight={headerRight}
      />
      <SessionFilterChips
        platformFilter={platformFilter}
        projectFilter={projectFilter}
        projectOptions={filterOptions.projectOptions}
        onRemovePlatform={platform => {
          setPlatformFilter(prev => prev.filter(value => value !== platform));
        }}
        onRemoveProject={gitUrl => {
          setProjectFilter(prev => prev.filter(value => value !== gitUrl));
        }}
      />
      {body}
      {/* FAB visible when there are live rows — empty state already owns the creation CTA. */}
      {hasLiveRows && (
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
          selectedPlatforms={platformFilter}
          selectedProjects={projectFilter}
          projectOptions={filterOptions.projectOptions}
          platformOptions={filterOptions.platformOptions}
          onClose={() => {
            setShowFilterModal(false);
          }}
          onApply={filters => {
            setPlatformFilter(filters.platformFilter);
            setProjectFilter(filters.projectFilter);
          }}
        />
      )}
    </View>
  );
}
