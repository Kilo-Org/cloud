import { useFocusEffect, useScrollToTop } from 'expo-router';
import { Bot, Plus } from 'lucide-react-native';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  SectionList,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BodyEmpty } from '@/components/agents/session-list-body-empty';
import {
  selectSessionListBodyModel,
  type SessionListBodyModel,
} from '@/components/agents/session-list-body-model';
import { selectSessionListContentSurface } from '@/components/agents/session-list-content-surface';
import { type SessionSection } from '@/components/agents/session-list-helpers';
import { shouldResetScrollOnCommittedQuery } from '@/components/agents/session-list-scroll-reset';
import { SessionListSectionHeader } from '@/components/agents/session-list-section-header';
import { StoredSessionRow } from '@/components/agents/session-row';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getRevisionSnapshot } from '@/lib/session-attention';
import { getEffectiveTabBarHeight } from '@/lib/tab-bar-layout';

type AgentSessionListContentProps = {
  sections: SessionSection[];
  hasAnySessions: boolean;
  /** True when the pinned "Active now" tray is non-empty. Used by the
   * render model to keep the inline "Couldn't refresh" line visible and
   * to suppress the full-screen QueryError when the tray is the only
   * thing on screen. */
  hasPinnedActive: boolean;
  isLoading: boolean;
  /** Body-driving error flag — a search failure (when searching) OR a
   * stored/history failure. Active-only failures are surfaced separately
   * via the body's `showInlineError` output, NEVER as the empty-state
   * message. */
  isError: boolean;
  /** Active-poll failure — drives ONLY the inline staleness line. */
  activeIsError: boolean;
  isFetchingNextPage: boolean;
  refetch: () => Promise<void>;
  onRetry: () => void;
  onEndReached: () => void;
  onSessionPress: (sessionId: string, organizationId?: string | null) => void;
  hasActiveQuery: boolean;
  isSearching: boolean;
  /** Committed (debounced) search query — scroll-to-top fires when this value changes. */
  searchQuery: string;
  onClearQuery: () => void;
  onCreateSession: () => void;
  sortBy: AgentSessionSortBy;
  /**
   * Pinned "Active now" tray rendered as `ListHeaderComponent` so it scrolls
   * with history in one continuous gesture. Not a virtualized cell — Reanimated
   * layout transitions on the tray keep working. Pass `null` when empty.
   */
  activeNowSection: ReactElement | null;
};

export function AgentSessionListContent({
  sections,
  hasAnySessions,
  hasPinnedActive,
  isLoading,
  isError,
  activeIsError,
  isFetchingNextPage,
  refetch,
  onRetry,
  onEndReached,
  onSessionPress,
  hasActiveQuery,
  isSearching,
  searchQuery,
  onClearQuery,
  onCreateSession,
  sortBy,
  activeNowSection,
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
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const { deleteSession, renameSession } = useSessionMutations();
  const [refreshing, setRefreshing] = useState(false);

  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it or the last rows are stuck underneath it.
  const tabBarClearanceStyle = useMemo(
    () => ({
      paddingBottom: getEffectiveTabBarHeight({
        bottomInset: bottom,
        platform: Platform.OS,
        fontScale,
      }),
    }),
    [bottom, fontScale]
  );

  const hasHistoryContent = sections.length > 0;

  // Pure body decision — see `session-list-body-model.ts`.
  const bodyModel = useMemo<SessionListBodyModel>(
    () =>
      selectSessionListBodyModel({
        hasHistoryContent,
        hasPinnedActive,
        hasActiveQuery,
        isSearching,
        isError,
        activeIsError,
      }),
    [activeIsError, hasActiveQuery, hasHistoryContent, hasPinnedActive, isError, isSearching]
  );

  const surface = useMemo(
    () =>
      selectSessionListContentSurface({
        isLoading,
        isError,
        hasAnySessions,
        hasPinnedActive,
        hasHistoryContent,
      }),
    [hasAnySessions, hasHistoryContent, hasPinnedActive, isError, isLoading]
  );

  const emptyStateAction = useMemo(
    () => (
      <Button variant="outline" onPress={onCreateSession}>
        <Plus size={16} color={colors.foreground} />
        <Text>New coding task</Text>
      </Button>
    ),
    [colors.foreground, onCreateSession]
  );

  const clearQueryAction = useMemo(
    () => (
      <Button variant="outline" onPress={onClearQuery}>
        <Text>{isSearching ? 'Clear search' : 'Clear filters'}</Text>
      </Button>
    ),
    [isSearching, onClearQuery]
  );

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the Agents list is frozen. On return, each row re-reads the ack
  // store via its own `useSyncExternalStore` subscription
  // (`useSessionAttentionRevision`). Snapshot the attention revision only when
  // the tab (re)gains focus via `useFocusEffect` (fires after unfreeze) and
  // pass it as `extraData` so visible cells re-render without remounting the
  // list — preserving scroll. Remount only on sort change (`key={sortBy}`).
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
        sortBy={sortBy}
        onPress={() => {
          onSessionPress(item.session_id, item.organization_id);
        }}
        onDelete={() => {
          deleteSession(item.session_id);
        }}
        onRename={newTitle => {
          renameSession(item.session_id, newTitle);
        }}
      />
    ),
    [onSessionPress, deleteSession, renameSession, sortBy]
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
  // A populated tray counts as "something on screen" and also suppresses.
  // Gated on !isLoading so a cold-open load never flashes this surface.
  if (surface.kind === 'full-screen-error') {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center"
        style={tabBarClearanceStyle}
      >
        <QueryError message="Could not load sessions" onRetry={onRetry} />
      </Animated.View>
    );
  }

  // The screen gates the search header on `hasAnySessions` to keep the
  // first-use "No sessions yet" empty state chrome-free, so when the user
  // has no sessions at all we skip the SectionList entirely here and just
  // render the empty state. Gated on !isLoading (via surface) so a cold
  // open with an empty cache does not flash this while queries run.
  if (surface.kind === 'first-use-empty') {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center"
        style={tabBarClearanceStyle}
      >
        <EmptyState
          icon={Bot}
          title="No sessions yet"
          description="Start a coding task from your phone. Your sessions will appear here."
          action={emptyStateAction}
        />
      </Animated.View>
    );
  }

  // Single SectionList render site: tray stays in ListHeaderComponent across
  // loading → rows so ActiveNowSection's local expanded state is not reset.
  // While loading, sections are empty and skeletons fill ListEmptyComponent
  // under the tray (active query may already have resolved).
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
    emptyComponent = (
      <BodyEmpty
        kind={bodyModel.kind}
        isSearching={isSearching}
        secondaryAction={
          bodyModel.kind === 'query-error-empty' ? bodyModel.secondaryAction : undefined
        }
        emptyStateAction={emptyStateAction}
        clearQueryAction={clearQueryAction}
        onRetry={onRetry}
      />
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      <SectionList<StoredSession, SessionSection>
        ref={listRef}
        key={sortBy}
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        extraData={attentionFocusRevision}
        ListHeaderComponent={activeNowSection}
        ListEmptyComponent={emptyComponent}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="py-4">
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : null
        }
        contentContainerStyle={tabBarClearanceStyle}
        keyboardDismissMode="on-drag"
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      />
    </Animated.View>
  );
}
