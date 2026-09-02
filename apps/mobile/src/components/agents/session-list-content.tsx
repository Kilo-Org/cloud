/* eslint-disable max-lines -- Session-list content and its error/empty surfaces are kept together. */
import { useFocusEffect, useScrollToTop } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  SectionList,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BodyEmpty } from '@/components/agents/session-list-body-empty';
import { selectSessionListBodyModel } from '@/components/agents/session-list-body-model';
import { selectSessionListContentSurface } from '@/components/agents/session-list-content-surface';
import { type SessionSection } from '@/components/agents/session-list-helpers';
import { shouldResetScrollOnCommittedQuery } from '@/components/agents/session-list-scroll-reset';
import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { StoredSessionRow } from '@/components/agents/session-row';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { moveA11yFocus } from '@/lib/a11y/announce';
import { SESSION_LIST_SORT } from '@/lib/agent-session-sort';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

export const FAB_SIZE = 56;
export const FAB_MARGIN = 16;

type AgentSessionListContentProps = {
  /** Post-deletion focus anchor: the screen's always-mounted search input. */
  searchInputRef: Parameters<typeof moveA11yFocus>[0];
  sections: SessionSection[];
  activeSessionIds: ReadonlySet<string>;
  hasAnySessions: boolean;
  isLoading: boolean;
  /** Body-driving error flag — a search failure (when searching) OR a
   * stored/history failure. */
  isError: boolean;
  isFetchingNextPage: boolean;
  refetch: () => Promise<void>;
  onRetry: () => void;
  onEndReached: () => void;
  onSessionPress: (sessionId: string, organizationId?: string | null, title?: string) => void;
  hasActiveQuery: boolean;
  isSearching: boolean;
  /** Committed (debounced) search query — scroll-to-top fires when this value changes. */
  searchQuery: string;
  onClearQuery: () => void;
  /** Optional no-op accepted for the history screen's call-site compatibility. */
  onCreateSession?: () => void;
};

export function AgentSessionListContent({
  searchInputRef,
  sections,
  activeSessionIds,
  hasAnySessions,
  isLoading,
  isError,
  isFetchingNextPage,
  refetch,
  onRetry,
  onEndReached,
  onSessionPress,
  hasActiveQuery,
  isSearching,
  searchQuery,
  onClearQuery,
}: Readonly<AgentSessionListContentProps>) {
  const listRef = useRef<SectionList<StoredSession, SessionSection>>(null);
  useScrollToTop(listRef);

  // Scroll to top on committed-query change only. Skip the initial mount
  // (offset is already 0). Must not fire on focus refetch, attention
  // revision, sort remount, pagination, pull-to-refresh, or section-data
  // identity changes with an unchanged query.
  const prevSearchQueryRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSearchQueryRef.current;
    prevSearchQueryRef.current = searchQuery;
    if (!shouldResetScrollOnCommittedQuery(prev, searchQuery)) {
      return;
    }
    listRef.current?.getScrollResponder()?.scrollTo({ y: 0, animated: false });
  }, [searchQuery]);

  const colors = useThemeColors();
  const { t } = useTranslation();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const { deleteSession, renameSession } = useSessionMutations();
  const [refreshing, setRefreshing] = useState(false);

  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it or the last rows are stuck underneath it. The history list
  // owns no FAB, so tab-bar-only clearance is the only inset it needs.
  const tabBarOnlyClearanceStyle = useMemo(
    () => ({
      paddingBottom: getEffectiveTabBarHeight({
        bottomInset: bottom,
        platform: Platform.OS,
        fontScale,
      }),
    }),
    [bottom, fontScale]
  );

  // Pure body decision — see `session-list-body-model.ts`.
  const bodyModel = selectSessionListBodyModel({
    hasHistoryContent: sections.length > 0,
    hasActiveQuery,
    isSearching,
    isError,
  });

  const surface = selectSessionListContentSurface({
    isLoading,
    isError,
    hasAnySessions,
    hasHistoryContent: sections.length > 0,
  });

  const clearQueryAction = useMemo(
    () => (
      <Button variant="outline" onPress={onClearQuery}>
        <Text>
          {isSearching ? t('agents.search.clearSearch') : t('agents.search.clearFilters')}
        </Text>
      </Button>
    ),
    [isSearching, onClearQuery, t]
  );

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the Agents list is frozen. On return, each row re-reads the ack
  // store via its own `useSyncExternalStore` subscription
  // (`useSessionAttentionRevision`). Snapshot the attention revision only when
  // the tab (re)gains focus via `useFocusEffect` (fires after unfreeze) and
  // pass it as `extraData` so visible cells re-render without remounting the
  // list — preserving scroll.
  const [attentionFocusRevision, setAttentionFocusRevision] = useState(getRevisionSnapshot);
  useFocusEffect(
    useCallback(() => {
      setAttentionFocusRevision(getRevisionSnapshot());
    }, [])
  );

  const handleRefresh = useCallback(() => {
    void (async () => {
      setRefreshing(true);
      try {
        await refetch();
      } finally {
        setRefreshing(false);
      }
    })();
  }, [refetch]);

  const renderItem = useCallback(
    ({ item }: { item: StoredSession }) => (
      <StoredSessionRow
        session={item}
        sortBy={SESSION_LIST_SORT}
        live={activeSessionIds.has(item.session_id)}
        metaWhileLive
        onPress={() => {
          onSessionPress(item.session_id, item.organization_id, item.title ?? undefined);
        }}
        onDelete={() => {
          // The hook's success toast announces the deletion; onDeleted only
          // restores focus, and moveA11yFocus no-ops once the header is
          // unmounted (last session deleted).
          deleteSession(item.session_id, () => {
            moveA11yFocus(searchInputRef);
          });
        }}
        onRename={newTitle => {
          renameSession(item.session_id, newTitle);
        }}
      />
    ),
    [activeSessionIds, onSessionPress, deleteSession, renameSession, searchInputRef]
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SessionSection }) => (
      <SessionListSectionHeader title={section.title} count={section.data.length} />
    ),
    []
  );

  const keyExtractor = useCallback((item: StoredSession) => item.session_id, []);

  // Full-screen error only when there is nothing cached to fall back on —
  // a background refetch/search failure with stale sessions already in
  // cache (keepPreviousData) must never blank out what's already rendered.
  // Gated on !isLoading so a cold-open load never flashes this surface.
  if (surface.kind === 'full-screen-error') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <QueryError
          message={t('agents.sessionList.couldNotLoad')}
          onRetry={onRetry}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        />
      </Animated.View>
    );
  }

  // No stored rows and no active query: render the history-empty body ("No
  // past sessions" with no create CTA) full-screen, skipping the SectionList.
  // Gated on !isLoading (via surface) so a cold open with an empty cache does
  // not flash this while queries run.
  if (surface.kind === 'history-empty') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <BodyEmpty
          kind="no-past-sessions"
          isSearching={isSearching}
          clearQueryAction={clearQueryAction}
          onRetry={onRetry}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        />
      </Animated.View>
    );
  }

  // Single SectionList render site: while loading, sections are empty and
  // skeletons fill ListEmptyComponent (active query may already have
  // resolved).
  let emptyComponent: ReactNode = null;
  if (surface.listEmpty === 'loading-skeletons') {
    emptyComponent = (
      <Animated.View exiting={FadeOut.duration(150)}>
        {Array.from({ length: 8 }, (_, i) => (
          <View key={i} className="py-1.5">
            <Skeleton className="mx-[22px] h-[76px] rounded-none" />
          </View>
        ))}
      </Animated.View>
    );
  } else if (surface.listEmpty === 'body-empty' && bodyModel.kind !== 'render-list') {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <BodyEmpty
          kind={bodyModel.kind}
          isSearching={isSearching}
          secondaryAction={
            bodyModel.kind === 'query-error-empty' ? bodyModel.secondaryAction : undefined
          }
          clearQueryAction={clearQueryAction}
          onRetry={onRetry}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      <SectionList<StoredSession, SessionSection>
        ref={listRef}
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        extraData={attentionFocusRevision}
        ListHeaderComponent={null}
        ListEmptyComponent={emptyComponent}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="py-4">
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : null
        }
        contentContainerStyle={tabBarOnlyClearanceStyle}
        keyboardDismissMode="on-drag"
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        maintainVisibleContentPosition={{
          minIndexForVisible: 0,
          autoscrollToTopThreshold: 10,
        }}
      />
    </Animated.View>
  );
}
