import { useFocusEffect } from 'expo-router';
import { Bot, Plus } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  SectionList,
  type TextInput,
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
import { type SessionSection } from '@/components/agents/session-list-helpers';
import { SessionListSearchHeader } from '@/components/agents/session-list-search-header';
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
import { getTabBarOverlayHeight } from '@/lib/tab-bar-layout';

// Height of the hidden-by-default search bar (mt-3 12 + border 1 + py-1.5 12 + line-20 + border 1 + mb-14 14 = 60).
const SEARCH_BAR_HEIGHT = 60;

type AgentSessionListContentProps = {
  sections: SessionSection[];
  hasAnySessions: boolean;
  /** True when the pinned "Active now" tray is non-empty. Used by the
   * render model to keep the inline "Couldn't refresh" line visible and
   * to suppress the full-screen QueryError when the tray is the only
   * thing on screen. */
  hasPinnedActive: boolean;
  isLoading: boolean;
  isSearchPending: boolean;
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
  onSearchChange: (text: string) => void;
  hasActiveQuery: boolean;
  isSearching: boolean;
  onClearQuery: () => void;
  /**
   * Narrow clear path used by the in-field X: resets the debounced search
   * query (and the local `hasText` flag) WITHOUT touching the persisted
   * platform/project filters. The empty-state "Clear search"/"Clear filters"
   * CTA keeps owning the broader `onClearQuery` path.
   */
  onClearSearchOnly: () => void;
  onCreateSession: () => void;
  sortBy: AgentSessionSortBy;
};

export function AgentSessionListContent({
  sections,
  hasAnySessions,
  hasPinnedActive,
  isLoading,
  isSearchPending,
  isError,
  activeIsError,
  isFetchingNextPage,
  refetch,
  onRetry,
  onEndReached,
  onSessionPress,
  onSearchChange,
  hasActiveQuery,
  isSearching,
  onClearQuery,
  onClearSearchOnly,
  onCreateSession,
  sortBy,
}: Readonly<AgentSessionListContentProps>) {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const { deleteSession, renameSession } = useSessionMutations();
  const [refreshing, setRefreshing] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  // Drives the in-field X's visibility only — the input itself stays
  // uncontrolled (see iOS TextInput rules). Derived from `onChangeText`.
  const [hasText, setHasText] = useState(false);

  // The search TextInput is uncontrolled (see iOS TextInput rules — controlled
  // `value` causes keystroke races), so clearing the query in state alone
  // wouldn't clear what's visibly typed. Imperatively clear the input too.
  const handleClearQuery = useCallback(() => {
    searchInputRef.current?.clear();
    setHasText(false);
    onClearQuery();
  }, [onClearQuery]);

  const handleSearchInputChange = useCallback(
    (text: string) => {
      setHasText(text.length > 0);
      onSearchChange(text);
    },
    [onSearchChange]
  );

  // Narrow path used by the in-field X: clears the input, dismisses the
  // keyboard, and resets `hasText` so the X hides — without touching filters.
  const handleClearSearchOnly = useCallback(() => {
    searchInputRef.current?.clear();
    searchInputRef.current?.blur();
    setHasText(false);
    onClearSearchOnly();
  }, [onClearSearchOnly]);
  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it or the last rows are stuck underneath it.
  const tabBarClearanceStyle = useMemo(
    () => ({ paddingBottom: getTabBarOverlayHeight(bottom, Platform.OS, fontScale) }),
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

  const listHeader = useMemo(
    () => (
      <SessionListSearchHeader
        inputRef={searchInputRef}
        hasText={hasText}
        isSearchPending={isSearchPending}
        showInlineError={bodyModel.showInlineError}
        onChangeText={handleSearchInputChange}
        onClearSearch={handleClearSearchOnly}
      />
    ),
    [
      bodyModel.showInlineError,
      handleClearSearchOnly,
      handleSearchInputChange,
      hasText,
      isSearchPending,
    ]
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
      <Button variant="outline" onPress={handleClearQuery}>
        <Text>{isSearching ? 'Clear search' : 'Clear filters'}</Text>
      </Button>
    ),
    [handleClearQuery, isSearching]
  );

  // The tabs navigator uses `freezeOnBlur`, so while the session detail screen
  // is pushed the Agents list is frozen. react-freeze reveals the previously
  // rendered (cached) cells on return WITHOUT re-running them, so the attention
  // store's `useSyncExternalStore` subscription does not re-render the list and
  // the detail-screen mount ack is not reflected. Snapshot the attention
  // revision only when the tab (re)gains focus, via `useFocusEffect`, which
  // fires reliably after unfreeze. Keying the list on that focus snapshot
  // remounts it exactly when an ack/reconcile happened while the list was away
  // (e.g. returning from a session that was just opened) so frozen cells re-read
  // the ack store — while a revision bump for some unrelated session that occurs
  // *during* browsing does not touch the snapshot, so scroll is preserved.
  const [attentionFocusRevision, setAttentionFocusRevision] = useState(getRevisionSnapshot);
  useFocusEffect(
    useCallback(() => {
      setAttentionFocusRevision(getRevisionSnapshot());
    }, [])
  );
  const attentionListKey = `${sortBy}:${attentionFocusRevision}`;

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

  if (isLoading) {
    return (
      <Animated.View exiting={FadeOut.duration(150)}>
        {Array.from({ length: 8 }, (_, i) => (
          <View key={i} className="py-1.5">
            <Skeleton className="mx-[22px] h-[76px] rounded-none" />
          </View>
        ))}
      </Animated.View>
    );
  }

  // Full-screen error only when there is nothing cached to fall back on —
  // a background refetch/search failure with stale sessions already in
  // cache (keepPreviousData) must never blank out what's already rendered.
  // A populated tray counts as "something on screen" and also suppresses.
  if (isError && !hasAnySessions && !hasPinnedActive) {
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

  // The `contentOffset` trick that hides the search bar by default requires
  // scrollable content, so when the user has no sessions at all we skip
  // the SectionList entirely — mounting it with only a ListEmptyComponent
  // would leave the search bar fully visible.
  if (!hasAnySessions) {
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

  let emptyComponent: React.ReactNode = null;
  if (bodyModel.kind !== 'render-list') {
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
        key={attentionListKey}
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        extraData={attentionListKey}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={emptyComponent}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="py-4">
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : null
        }
        contentContainerStyle={tabBarClearanceStyle}
        contentOffset={{ x: 0, y: SEARCH_BAR_HEIGHT }}
        keyboardDismissMode="on-drag"
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      />
    </Animated.View>
  );
}
