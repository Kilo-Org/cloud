import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { chatConversationPath } from '@/lib/kilo-chat-routes';
import { Plus } from 'lucide-react-native';

import { EmptyConversationList } from './empty-conversation-list';
import { groupConversationsByActivity } from './conversation-list-groups';
import { getConversationListContentState } from './conversation-list-state';
import { ConversationRow } from './conversation-row';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import {
  useConversations,
  useCreateConversation,
  useLeaveConversation,
} from './hooks/use-conversations';
import { useInstancePresence } from './hooks/use-instance-presence';
import { useNowTicker } from './hooks/use-now-ticker';

type Props = {
  sandboxId: string;
  sandboxLabel: string;
};

type ConversationItem = {
  kind: 'conversation';
  conversation: NonNullable<ReturnType<typeof useConversations>['data']>['conversations'][number];
};

type ConversationHeaderItem = {
  kind: 'header';
  label: string;
};

type ConversationListEntry = ConversationHeaderItem | ConversationItem;

function ConversationListSkeleton({ showHeader }: Readonly<{ showHeader?: boolean }>) {
  return (
    <View className="px-4 py-2">
      {showHeader ? <Skeleton className="mb-2 h-4 w-24 rounded-md" /> : null}
      {[0, 1, 2, 3].map(i => (
        <View key={i} className="flex-row items-center gap-3 py-3">
          <View className="flex-1 gap-2">
            <Skeleton className="h-5 w-2/3 rounded-md" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </View>
          <Skeleton className="h-2.5 w-2.5 rounded-full" />
        </View>
      ))}
    </View>
  );
}

function flattenConversationGroups(
  conversations: NonNullable<ReturnType<typeof useConversations>['data']>['conversations'],
  nowMs: number
): ConversationListEntry[] {
  const entries: ConversationListEntry[] = [];
  for (const group of groupConversationsByActivity(conversations, nowMs)) {
    entries.push({ kind: 'header', label: group.label });
    for (const conversation of group.items) {
      entries.push({ kind: 'conversation', conversation });
    }
  }
  return entries;
}

export function ConversationListScreen({ sandboxId, sandboxLabel }: Props) {
  const router = useRouter();
  const colors = useThemeColors();
  const client = useKiloChatClient();
  const listQuery = useConversations(client, sandboxId);
  const createConversation = useCreateConversation(client);
  const leaveConversation = useLeaveConversation(client);
  const now = useNowTicker(60_000);

  const hasNextPage = listQuery.hasNextPage;
  const isFetchingNextPage = listQuery.isFetchingNextPage;
  const fetchNextPage = listQuery.fetchNextPage;

  useInstancePresence(sandboxId);

  function handleRowPress(conversationId: string) {
    router.push(chatConversationPath(sandboxId, conversationId));
  }

  function handleCreateAndNavigate() {
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: result => {
          router.push(chatConversationPath(sandboxId, result.conversationId));
        },
      }
    );
  }

  function handleLeave(conversationId: string) {
    leaveConversation.mutate({ conversationId, sandboxId });
  }

  const fetchMoreConversations = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage({ cancelRefetch: false });
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const contentState = getConversationListContentState({
    isPending: listQuery.isPending,
    isError: listQuery.isError,
    hasData: listQuery.data !== undefined,
  });

  if (contentState === 'loading') {
    return (
      <View className="flex-1">
        <ScreenHeader title={sandboxLabel} />
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <ConversationListSkeleton showHeader />
        </Animated.View>
      </View>
    );
  }

  if (contentState === 'error') {
    return (
      <View className="flex-1">
        <ScreenHeader title={sandboxLabel} />
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <QueryError
            className="flex-1"
            message="Could not load conversations"
            onRetry={() => {
              void listQuery.refetch();
            }}
          />
        </Animated.View>
      </View>
    );
  }

  const conversations = listQuery.data?.conversations ?? [];
  const entries = flattenConversationGroups(conversations, now);

  return (
    <View className="flex-1">
      <ScreenHeader
        title={sandboxLabel}
        headerRight={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New conversation"
            disabled={createConversation.isPending}
            onPress={handleCreateAndNavigate}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted disabled:opacity-50"
          >
            {createConversation.isPending ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <Plus size={20} color={colors.foreground} />
            )}
          </Pressable>
        }
      />
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlashList
          data={entries}
          keyExtractor={entry =>
            entry.kind === 'header' ? `header:${entry.label}` : entry.conversation.conversationId
          }
          renderItem={({ item }) =>
            item.kind === 'header' ? (
              <View className="bg-background px-4 pb-1 pt-4">
                <Text variant="eyebrow">{item.label}</Text>
              </View>
            ) : (
              <View className="px-2">
                <ConversationRow
                  conversation={item.conversation}
                  sandboxId={sandboxId}
                  onPress={handleRowPress}
                  onLeave={handleLeave}
                />
              </View>
            )
          }
          ListEmptyComponent={
            <EmptyConversationList
              onStart={handleCreateAndNavigate}
              isStarting={createConversation.isPending}
            />
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="px-4 py-3">
                <ConversationListSkeleton />
              </View>
            ) : null
          }
          onEndReached={fetchMoreConversations}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={listQuery.isRefetching && !listQuery.isFetchingNextPage}
              onRefresh={() => {
                void listQuery.refetch();
              }}
            />
          }
        />
      </Animated.View>
    </View>
  );
}
