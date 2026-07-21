import { useFocusEffect } from 'expo-router';
import { Search, X } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type SessionItem, type SessionSection } from '@/components/agents/session-list-helpers';
import {
  AgentSessionFilteredEmptyState,
  AgentSessionListEmptyState,
} from '@/components/agents/session-list-empty-states';
import { RemoteSessionRow, StoredSessionRow } from '@/components/agents/session-row';
import { QueryError } from '@/components/query-error';
import { Eyebrow } from '@/components/ui/eyebrow';
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
  storedSessions: StoredSession[];
  hasAnySessions: boolean;
  isLoading: boolean;
  isSearchPending: boolean;
  isError: boolean;
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
   * Narrow clear path used by the in-field X: resets the debounced
   * search query (and the local `hasText` flag) WITHOUT touching the
   * persisted platform/project narrowing filters. The broad
   * `onClearQuery` path keeps owning that.
   */
  onClearSearchOnly: () => void;
  onCreateSession: () => void;
  sortBy: AgentSessionSortBy;
};

export function AgentSessionListContent({
  sections,
  storedSessions,
  hasAnySessions,
  isLoading,
  isSearchPending,
  isError,
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
  // Tracks whether the uncontrolled TextInput currently has visible
  // text — the iOS search-field X is only rendered while this is true.
  // Derived locally from `onChangeText`; the TextInput itself stays
  // uncontrolled per the iOS TextInput rule (controlled `value` races
  // with native keystrokes on iOS).
  const [hasText, setHasText] = useState(false);

  // The search TextInput is uncontrolled (see iOS TextInput rules — controlled
  // `value` causes keystroke races), so clearing the query in state alone
  // wouldn't clear what's visibly typed. Imperatively clear the input too.
  //
  // Broad path used by the empty-state "Clear search" / "Clear filters"
  // CTAs: the screen's `onClearQuery` ALSO resets the persisted
  // platform/project narrowing filters, which is why the X has its own
  // narrower handler below.
  const handleClearQuery = useCallback(() => {
    searchInputRef.current?.clear();
    setHasText(false);
    onClearQuery();
  }, [onClearQuery]);

  // Narrow path used by the in-field X: clears the input, dismisses
  // the keyboard, and resets the local `hasText` flag so the X
  // disappears — all without touching the persisted narrowing filters.
  const handleClearSearchOnly = useCallback(() => {
    searchInputRef.current?.clear();
    searchInputRef.current?.blur();
    setHasText(false);
    onClearSearchOnly();
  }, [onClearSearchOnly]);

  const handleSearchInputChange = useCallback(
    (text: string) => {
      setHasText(text.length > 0);
      onSearchChange(text);
    },
    [onSearchChange]
  );
  // The tab bar is an absolutely-positioned overlay, so scrollable content
  // must clear it or the last rows are stuck underneath it.
  const tabBarClearanceStyle = useMemo(
    () => ({ paddingBottom: getTabBarOverlayHeight(bottom, Platform.OS, fontScale) }),
    [bottom, fontScale]
  );

  // When the list is empty the error surface below (QueryError + retry)
  // already covers it — don't double up with the inline header line.
  const showInlineError = isError && sections.length > 0;

  const listHeader = useMemo(
    () => (
      <View>
        <View className="mx-[22px] mb-[14px] mt-3 flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-1.5">
          <Search size={18} color={colors.mutedForeground} />
          <TextInput
            ref={searchInputRef}
            className="min-h-6 flex-1 py-1 text-[15px] leading-6 text-foreground"
            placeholder="Search sessions..."
            placeholderTextColor={colors.mutedForeground}
            onChangeText={handleSearchInputChange}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {hasText ? (
            <Pressable
              onPress={handleClearSearchOnly}
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={12}
              className="active:opacity-70"
            >
              <X size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
        {isSearchPending ? (
          <View className="mx-[22px] mb-[14px] flex-row items-center gap-2">
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text variant="muted" className="text-xs">
              Searching…
            </Text>
          </View>
        ) : null}
        {showInlineError ? (
          <Text variant="muted" className="mx-[22px] mb-[14px] text-xs">
            Couldn't refresh. Pull down to try again.
          </Text>
        ) : null}
      </View>
    ),
    [
      colors.mutedForeground,
      handleClearSearchOnly,
      handleSearchInputChange,
      hasText,
      isSearchPending,
      showInlineError,
    ]
  );

  const organizationIdBySessionId = useMemo(
    () => new Map(storedSessions.map(s => [s.session_id, s.organization_id])),
    [storedSessions]
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
    ({ item }: { item: SessionItem }) => {
      if (item.kind === 'stored') {
        return (
          <StoredSessionRow
            session={item.session}
            isLive={item.isLive}
            sortBy={sortBy}
            onPress={() => {
              onSessionPress(item.session.session_id, item.session.organization_id);
            }}
            onDelete={() => {
              deleteSession(item.session.session_id);
            }}
            onRename={newTitle => {
              renameSession(item.session.session_id, newTitle);
            }}
          />
        );
      }
      return (
        <RemoteSessionRow
          session={{
            id: item.session.id,
            title: item.session.title,
            status: item.session.status,
            gitBranch: item.session.gitBranch,
            platform: item.session.platform,
          }}
          onPress={() => {
            onSessionPress(item.session.id, organizationIdBySessionId.get(item.session.id));
          }}
        />
      );
    },
    [onSessionPress, deleteSession, renameSession, organizationIdBySessionId, sortBy]
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: SessionSection }) => (
      <View className="flex-row items-center justify-between bg-background px-[22px] pb-2 pt-[18px]">
        <Eyebrow>{section.title}</Eyebrow>
        <Text variant="mono" className="text-[10px] uppercase tracking-[1.5px] text-muted-soft">
          {section.data.length}
        </Text>
      </View>
    ),
    []
  );

  const keyExtractor = useCallback(
    (item: SessionItem) => (item.kind === 'stored' ? item.session.session_id : item.session.id),
    []
  );

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
  if (isError && !hasAnySessions) {
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

  // When the user has no sessions at all, skip the SectionList entirely. The `contentOffset`
  // trick that hides the search bar by default requires scrollable content, so mounting the
  // list with only a ListEmptyComponent would leave the search bar fully visible.
  if (!hasAnySessions) {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1"
        style={tabBarClearanceStyle}
      >
        <AgentSessionListEmptyState onCreateSession={onCreateSession} />
      </Animated.View>
    );
  }

  let emptyComponent = null;
  if (hasActiveQuery) {
    emptyComponent = (
      <AgentSessionFilteredEmptyState
        variant={isError ? 'queryError' : 'filtered'}
        isSearching={isSearching}
        onClearQuery={handleClearQuery}
        onRetry={onRetry}
      />
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      <SectionList<SessionItem, SessionSection>
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
