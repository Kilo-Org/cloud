import { Bot, Plus, Search, SearchX } from 'lucide-react-native';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  SectionList,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type SessionItem, type SessionSection } from '@/components/agents/session-list-helpers';
import { RemoteSessionRow, StoredSessionRow } from '@/components/agents/session-row';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
  onCreateSession,
  sortBy,
}: Readonly<AgentSessionListContentProps>) {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const { deleteSession, renameSession } = useSessionMutations();
  const [refreshing, setRefreshing] = useState(false);
  const searchInputRef = useRef<TextInput>(null);

  // The search TextInput is uncontrolled (see iOS TextInput rules — controlled
  // `value` causes keystroke races), so clearing the query in state alone
  // wouldn't clear what's visibly typed. Imperatively clear the input too.
  const handleClearQuery = useCallback(() => {
    searchInputRef.current?.clear();
    onClearQuery();
  }, [onClearQuery]);
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
            onChangeText={onSearchChange}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
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
    [colors.mutedForeground, showInlineError, isSearchPending, onSearchChange]
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

  // Only reachable when `hasAnySessions` is true (the true first-use empty
  // state is handled separately below), which means an active search or
  // filter narrowed the results to zero matches — never show the "create a
  // task" CTA here, it's not the fix for a filter that's too narrow.
  const filteredEmptyComponent = useMemo(
    () => (
      <View className="items-center justify-center pt-16">
        <EmptyState
          icon={SearchX}
          title="No sessions match"
          description={
            isSearching ? 'Try a different search term.' : 'Try adjusting or clearing your filters.'
          }
          action={clearQueryAction}
        />
      </View>
    ),
    [clearQueryAction, isSearching]
  );

  // The query in error produced no rows to show — surface a retry for it
  // (search or list, whichever `onRetry` targets) instead of pretending the
  // empty result is a real "no matches".
  const queryErrorEmptyComponent = useMemo(
    () => (
      <View className="items-center gap-4 pt-16">
        <QueryError
          placement="top"
          className="pt-0"
          message={isSearching ? 'Could not search sessions' : 'Could not load sessions'}
          onRetry={onRetry}
        />
        {clearQueryAction}
      </View>
    ),
    [clearQueryAction, isSearching, onRetry]
  );

  const organizationIdBySessionId = useMemo(
    () => new Map(storedSessions.map(s => [s.session_id, s.organization_id])),
    [storedSessions]
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
          session={item.session}
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

  let emptyComponent = null;
  if (hasActiveQuery) {
    emptyComponent = isError ? queryErrorEmptyComponent : filteredEmptyComponent;
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      <SectionList<SessionItem, SessionSection>
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
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
