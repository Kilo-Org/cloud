import { Bot } from 'lucide-react-native';
import { useCallback, useMemo } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { type SessionItem, type SessionSection } from '@/components/agents/session-list-helpers';
import { RemoteSessionRow, StoredSessionRow } from '@/components/agents/session-row';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type StoredSession } from '@/lib/hooks/use-agent-sessions';
import { useSessionMutations } from '@/lib/hooks/use-session-mutations';

type AgentSessionListContentProps = {
  sections: SessionSection[];
  storedSessions: StoredSession[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<void>;
  onSessionPress: (sessionId: string, organizationId?: string | null) => void;
};

export function AgentSessionListContent({
  sections,
  storedSessions,
  isLoading,
  isError,
  refetch,
  onSessionPress,
}: Readonly<AgentSessionListContentProps>) {
  const { deleteSession, renameSession } = useSessionMutations();
  const isEmpty = sections.length === 0 && !isLoading;

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
      <Text className="px-4 pb-1 pt-4 text-xs font-semibold uppercase text-muted-foreground">
        {section.title}
      </Text>
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
            <Skeleton className="mx-4 h-12 rounded-lg" />
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

  if (isEmpty) {
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
        refreshControl={<RefreshControl refreshing={false} onRefresh={handleRefresh} />}
      />
    </Animated.View>
  );
}
