import { FlashList } from '@shopify/flash-list';
import { type Href, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { timeAgo } from '@/lib/utils';

import { EmptyConversationList } from './empty-conversation-list';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { useConversations, useCreateConversation } from './hooks/use-conversations';
import { useInstanceEventSubscription } from './hooks/use-instance-event-subscription';
import { useInstancePresence } from './hooks/use-instance-presence';

type Props = {
  sandboxId: string;
  sandboxLabel: string;
};

type ConversationItem = {
  conversationId: string;
  title: string | null;
  lastActivityAt: number | null;
  lastReadAt: number | null;
  joinedAt: number;
};

type ConversationRowProps = {
  item: ConversationItem;
  onPress: (id: string) => void;
};

function ConversationRow({ item, onPress }: ConversationRowProps) {
  const hasUnread =
    item.lastActivityAt !== null &&
    (item.lastReadAt === null || item.lastReadAt < item.lastActivityAt);

  return (
    <Pressable
      className="flex-row items-center gap-3 px-4 py-3 active:opacity-80"
      onPress={() => {
        onPress(item.conversationId);
      }}
    >
      <View className="flex-1">
        <Text className="text-base font-medium text-foreground" numberOfLines={1}>
          {item.title ?? 'Untitled conversation'}
        </Text>
        {item.lastActivityAt !== null ? (
          <Text className="mt-0.5 text-sm text-muted-foreground">
            {timeAgo(new Date(item.lastActivityAt))}
          </Text>
        ) : null}
      </View>
      {hasUnread ? (
        <View className="h-2.5 w-2.5 rounded-full bg-primary" accessibilityLabel="Unread" />
      ) : (
        // Reserve space so rows stay the same width whether the dot is shown or not
        <View className="h-2.5 w-2.5" />
      )}
    </Pressable>
  );
}

export function ConversationListScreen({ sandboxId, sandboxLabel }: Props) {
  const router = useRouter();
  const client = useKiloChatClient();
  const listQuery = useConversations(client, sandboxId);
  const createConversation = useCreateConversation(client);

  const conversations = listQuery.data?.conversations ?? [];
  const isFetchingNextPage = listQuery.isFetchingNextPage;
  const fetchNextPage = listQuery.fetchNextPage;

  useInstanceEventSubscription(sandboxId);
  useInstancePresence(sandboxId);

  function handleRowPress(conversationId: string) {
    // Route lands in PR 5d (Task 47)
    router.push(`/(app)/chat/${sandboxId}/${conversationId}` as unknown as Href);
  }

  function handleCreateAndNavigate() {
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: result => {
          // Route lands in PR 5d (Task 47)
          router.push(`/(app)/chat/${sandboxId}/${result.conversationId}` as unknown as Href);
        },
      }
    );
  }

  return (
    <View className="flex-1">
      <ScreenHeader title={sandboxLabel} />
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlashList
          data={conversations}
          keyExtractor={c => c.conversationId}
          renderItem={({ item }) => <ConversationRow item={item} onPress={handleRowPress} />}
          ListEmptyComponent={
            <EmptyConversationList
              onStart={handleCreateAndNavigate}
              isStarting={createConversation.isPending}
            />
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="px-4 py-3">
                <Skeleton className="h-12 w-full rounded-md" />
              </View>
            ) : null
          }
          onEndReached={() => {
            void fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
        />
      </Animated.View>
    </View>
  );
}
