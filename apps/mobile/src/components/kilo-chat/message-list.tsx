import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { type ExecApprovalDecision, type Message } from '@kilocode/kilo-chat';
import { type PendingAction, pendingActionGroupIdForMessage } from '@kilocode/kilo-chat-hooks';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Keyboard, type NativeScrollEvent, type NativeSyntheticEvent, View } from 'react-native';

import { MessageBubble } from '@/components/kilo-chat/message-bubble';
import { Skeleton } from '@/components/ui/skeleton';
import { createMessageListKeyboardScrollScheduler } from './message-list-keyboard-scroll';
import { type MessageAuthorMember, resolveMessageAuthorLabel } from './message-presentation';

type Props = {
  messages: Message[];
  currentUserId: string | null;
  members?: readonly MessageAuthorMember[];
  botName?: string | null;
  fetchOlder?: () => void;
  isFetchingOlder: boolean;
  pendingAction: PendingAction | null;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
  onReactionPress: (message: Message, emoji: string) => void;
  onLongPressMessage?: (m: Message) => void;
  onSwipeReplyMessage?: (m: Message) => void;
};

export function MessageList({
  messages,
  currentUserId,
  members,
  botName,
  fetchOlder,
  isFetchingOlder,
  pendingAction,
  onExecuteAction,
  onReactionPress,
  onLongPressMessage,
  onSwipeReplyMessage,
}: Props) {
  const listRef = useRef<FlashListRef<Message>>(null);
  const scrollOffsetRef = useRef(0);
  const keyboardScrollScheduler = useMemo(
    () =>
      createMessageListKeyboardScrollScheduler({
        getScrollOffset: () => scrollOffsetRef.current,
        scrollToOffset: params => {
          listRef.current?.scrollToOffset(params);
        },
      }),
    []
  );
  // useMessages returns messages oldest-to-newest.
  // FlashList v2 does not support `inverted`; instead we use maintainVisibleContentPosition
  // with startRenderingFromBottom, which expects chronological order.
  const chronological = messages;
  const messageMap = useMemo(
    () => new Map(chronological.map(message => [message.id, message])),
    [chronological]
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', event => {
      keyboardScrollScheduler.schedule(event.endCoordinates.height);
    });

    return () => {
      subscription.remove();
      keyboardScrollScheduler.cancel();
    };
  }, [keyboardScrollScheduler]);

  return (
    <FlashList
      ref={listRef}
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
            authorLabel={resolveMessageAuthorLabel({ senderId: item.senderId, members, botName })}
            pendingActionGroupId={pendingActionGroupIdForMessage(pendingAction, item.id)}
            replyToMessage={
              item.inReplyToMessageId
                ? (messageMap.get(item.inReplyToMessageId) ?? item.replyTo)
                : null
            }
            onExecuteAction={onExecuteAction}
            onReactionPress={onReactionPress}
            onLongPress={onLongPressMessage}
            onSwipeReply={onSwipeReplyMessage}
          />
        );
      }}
      keyExtractor={item => item.id}
      onScroll={handleScroll}
      scrollEventThrottle={16}
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
