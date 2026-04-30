import { FlashList } from '@shopify/flash-list';
import { type Message } from '@kilocode/kilo-chat';
import { View } from 'react-native';

import { MessageBubble } from '@/components/kilo-chat/message-bubble';
import { Skeleton } from '@/components/ui/skeleton';

type Props = {
  messages: Message[];
  conversationId: string;
  currentUserId: string | null;
  fetchOlder?: () => void;
  hasOlder?: boolean;
  onLongPressMessage?: (m: Message) => void;
};

export function MessageList({
  messages,
  conversationId,
  currentUserId,
  fetchOlder,
  hasOlder,
  onLongPressMessage,
}: Props) {
  // useMessages returns messages newest-first (result of .reverse() in the hook).
  // FlashList v2 does not support `inverted`; instead we use maintainVisibleContentPosition
  // with startRenderingFromBottom. That requires data in chronological order (oldest first),
  // so we reverse once to get oldest→newest.
  const chronological = messages.toReversed();

  return (
    <FlashList
      data={chronological}
      renderItem={({ item, index }) => {
        // In chronological order, the previous message in time is data[index - 1].
        // showAuthor is true when the sender changes relative to the prior message,
        // or when this is the oldest message (index 0).
        const previousItem = chronological[index - 1];
        const showAuthor = previousItem === undefined || previousItem.senderId !== item.senderId;

        return (
          <MessageBubble
            message={item}
            conversationId={conversationId}
            isFromMe={currentUserId !== null && item.senderId === currentUserId}
            showAuthor={showAuthor}
            onLongPress={onLongPressMessage}
          />
        );
      }}
      keyExtractor={item => item.id}
      onStartReached={fetchOlder}
      onStartReachedThreshold={0.5}
      maintainVisibleContentPosition={{
        // Start rendering from the bottom so the newest message is visible on first render.
        startRenderingFromBottom: true,
      }}
      ListHeaderComponent={
        hasOlder ? (
          <View className="px-4 py-2">
            <Skeleton className="h-16 rounded-md" />
          </View>
        ) : null
      }
    />
  );
}
