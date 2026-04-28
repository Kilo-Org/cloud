import { useCallback } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { MessageCircle } from 'lucide-react-native';

import { type Message } from '@kilocode/kilo-chat';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import {
  useAddReaction,
  useDeleteMessage,
  useEditMessage,
  useMessageCacheUpdater,
  useMessages,
  useRemoveReaction,
} from './hooks/useMessages';
import { useCurrentUserId } from './hooks/use-current-user-id';
import { MessageBubble } from './message-bubble';

type MessageListProps = {
  sandboxId: string;
  conversationId: string;
};

export function MessageList({ sandboxId, conversationId }: Readonly<MessageListProps>) {
  const colors = useThemeColors();
  const currentUserId = useCurrentUserId();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(conversationId);
  const messages = data?.messages ?? [];

  const editMessage = useEditMessage(conversationId);
  const deleteMessage = useDeleteMessage(conversationId);
  const addReaction = useAddReaction(conversationId, currentUserId);
  const removeReaction = useRemoveReaction(conversationId, currentUserId);

  useMessageCacheUpdater(sandboxId, conversationId);

  const handleEdit = useCallback(
    (messageId: string, text: string) => {
      editMessage.mutate({
        messageId,
        conversationId,
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      });
    },
    [editMessage, conversationId]
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      deleteMessage.mutate({ messageId, conversationId });
    },
    [deleteMessage, conversationId]
  );

  const handleAddReaction = useCallback(
    (messageId: string, emoji: string) => {
      addReaction.mutate({ messageId, emoji });
    },
    [addReaction]
  );

  const handleRemoveReaction = useCallback(
    (messageId: string, emoji: string) => {
      removeReaction.mutate({ messageId, emoji });
    },
    [removeReaction]
  );

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        message={item}
        isOwn={item.senderId === currentUserId}
        currentUserId={currentUserId}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onAddReaction={handleAddReaction}
        onRemoveReaction={handleRemoveReaction}
      />
    ),
    [currentUserId, handleEdit, handleDelete, handleAddReaction, handleRemoveReaction]
  );

  if (messages.length === 0 && !isFetchingNextPage) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <View className="border border-border bg-muted rounded-lg px-8 py-6 items-center gap-3">
          <MessageCircle size={32} color={colors.mutedForeground} />
          <Text className="text-sm text-muted-foreground text-center">
            Start the conversation by sending a message below.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      className="flex-1"
      data={messages}
      keyExtractor={item => item.id}
      renderItem={renderItem}
      inverted
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.2}
      ListFooterComponent={
        isFetchingNextPage ? (
          <View className="py-4 items-center">
            <ActivityIndicator />
          </View>
        ) : null
      }
      contentContainerClassName="py-2"
    />
  );
}
