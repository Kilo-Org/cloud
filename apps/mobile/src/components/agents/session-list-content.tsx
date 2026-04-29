import { Bot, Search } from 'lucide-react-native';
import { useCallback, useMemo } from 'react';
import { RefreshControl, SectionList, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { type SessionItem, type SessionSection } from '@/components/agents/session-list-helpers';
import { RemoteSessionRow, StoredSessionRow } from '@/components/agents/session-row';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Eyebrow } from '@/components/ui/eyebrow';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// Height of the hidden-by-default search bar (mt-3 12 + border 1 + py-14 28 + line-20 + border 1 + mb-14 14 = 76).
const SEARCH_BAR_HEIGHT = 76;

type AgentSessionListContentProps = {
  sections: SessionSection[];
  storedSessions: StoredSession[];
  hasAnySessions: boolean;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<void>;
  onSessionPress: (sessionId: string, organizationId?: string | null) => void;
  onSearchChange: (text: string) => void;
};

export function AgentSessionListContent({
  sections,
  storedSessions,
  hasAnySessions,
  isLoading,
  isError,
  refetch,
  onSessionPress,
  onSearchChange,
}: Readonly<AgentSessionListContentProps>) {
  const colors = useThemeColors();
  const { deleteSession, renameSession } = useSessionMutations();

  const listHeader = useMemo(
    () => (
      <View className="mx-[22px] mb-[14px] mt-3 flex-row items-center gap-2 rounded-[10px] border border-border bg-card px-4 py-[14px]">
        <Search size={18} color={colors.mutedForeground} />
        <TextInput
          className="flex-1 text-[15px] leading-5 text-foreground"
          placeholder="Search sessions..."
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onSearchChange}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    ),
    [colors.mutedForeground, onSearchChange]
  );

  const listEmptyComponent = useMemo(
    () => (
      <View className="items-center justify-center pt-16">
        <EmptyState
          icon={Bot}
          title="No sessions yet"
          description="Your agent sessions will appear here"
        />
      </View>
    ),
    []
  );

  const organizationIdBySessionId = useMemo(
    () => new Map(storedSessions.map(s => [s.session_id, s.organization_id])),
    [storedSessions]
  );

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  const renderItem = useCallback(
    ({ item }: { item: SessionItem }) => {
      if (item.kind === 'stored') {
        return (
          <StoredSessionRow
            session={item.session}
            isLive={item.isLive}
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
    [onSessionPress, deleteSession, renameSession, organizationIdBySessionId]
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
            <Skeleton className="mx-[22px] h-12 rounded-lg" />
          </View>
        ))}
      </Animated.View>
    );
  }

  if (isError) {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1 items-center justify-center">
        <QueryError message="Could not load sessions" onRetry={() => void refetch()} />
      </Animated.View>
    );
  }

  // When the user has no sessions at all, skip the SectionList entirely. The `contentOffset`
  // trick that hides the search bar by default requires scrollable content, so mounting the
  // list with only a ListEmptyComponent would leave the search bar fully visible.
  if (!hasAnySessions) {
    return (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1 items-center justify-center">
        <EmptyState
          icon={Bot}
          title="No sessions yet"
          description="Your agent sessions will appear here"
        />
      </Animated.View>
    );
  }

  return (
    <Animated.View entering={FadeIn.duration(200)} className="flex-1">
      <SectionList<SessionItem, SessionSection>
        sections={sections}
        renderItem={renderItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={keyExtractor}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={listEmptyComponent}
        contentOffset={{ x: 0, y: SEARCH_BAR_HEIGHT }}
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} />}
      />
    </Animated.View>
  );
}
