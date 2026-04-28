import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import { type Href, useRouter } from 'expo-router';
import { toast } from 'sonner-native';

import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';

import { useConversations } from './hooks/use-conversations';
import { useInstanceEventSubscription } from './hooks/use-instance-event-subscription';
import { useKiloChatClient } from './hooks/use-kilo-chat-client';
import { EmptyConversationList } from './empty-conversation-list';

type ConversationListScreenProps = {
  sandboxId: string;
};

export function ConversationListScreen({ sandboxId }: Readonly<ConversationListScreenProps>) {
  const router = useRouter();
  const kiloChatClient = useKiloChatClient();
  const [isCreating, setIsCreating] = useState(false);

  useInstanceEventSubscription(sandboxId);

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useConversations(sandboxId);

  const conversations = data?.conversations ?? [];

  const handleStart = async () => {
    setIsCreating(true);
    try {
      const c = await kiloChatClient.createConversation({ sandboxId });
      router.push(`/(app)/chat/${sandboxId}/${c.conversationId}` as Href);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create conversation';
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleLoadMore = () => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  if (isLoading) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Conversations" />
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Conversations" />

      {conversations.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <EmptyConversationList onStart={handleStart} isCreating={isCreating} />
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={item => item.conversationId}
          contentContainerClassName="pb-8"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.2}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="py-4 items-center">
                <ActivityIndicator />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              className="border-b border-border px-4 py-3 active:bg-secondary will-change-pressable"
              accessibilityRole="button"
              accessibilityLabel={item.title ?? 'Conversation'}
              onPress={() => {
                router.push(`/(app)/chat/${sandboxId}/${item.conversationId}` as Href);
              }}
            >
              <Text className="text-base font-medium text-foreground" numberOfLines={1}>
                {item.title ?? 'Untitled conversation'}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
