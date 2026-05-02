import { FlashList } from '@shopify/flash-list';
import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { type PendingAction, pendingActionGroupIdForMessage } from '@kilocode/kilo-chat-hooks';
import { useMemo } from 'react';
import { View } from 'react-native';

import { MessageBubble } from '@/components/kilo-chat/message-bubble';
import { Skeleton } from '@/components/ui/skeleton';

type Props = {
  messages: Message[];
  currentUserId: string | null;
  fetchOlder?: () => void;
  isFetchingOlder: boolean;
  pendingAction: PendingAction | null;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
  onReactionPress: (message: Message, emoji: string) => void;
  onLongPressMessage?: (m: Message) => void;
};

export function MessageList({
  messages,
  currentUserId,
  fetchOlder,
  isFetchingOlder,
  pendingAction,
  onExecuteAction,
  onReactionPress,
  onLongPressMessage,
}: Props) {
  // useMessages returns messages oldest-to-newest.
  // FlashList v2 does not support `inverted`; instead we use maintainVisibleContentPosition
  // with startRenderingFromBottom, which expects chronological order.
  const chronological = messages;
  const messageMap = useMemo(
    () => new Map(chronological.map(message => [message.id, message])),
    [chronological]
  );

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
            currentUserId={currentUserId}
            isFromMe={currentUserId !== null && item.senderId === currentUserId}
            showAuthor={showAuthor}
            pendingActionGroupId={pendingActionGroupIdForMessage(pendingAction, item.id)}
            replyToMessage={
              item.inReplyToMessageId
                ? (messageMap.get(item.inReplyToMessageId) ?? item.replyTo)
                : null
            }
            onExecuteAction={onExecuteAction}
            onReactionPress={onReactionPress}
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
        isFetchingOlder ? (
          <View className="px-4 py-2">
            <Skeleton className="h-16 rounded-md" />
          </View>
        ) : null
      }
    />
  );
}
