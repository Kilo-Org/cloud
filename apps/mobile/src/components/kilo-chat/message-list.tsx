import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { type ExecApprovalDecision, type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { type PendingAction, pendingActionGroupIdForMessage } from '@kilocode/kilo-chat-hooks';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
  type ViewStyle,
} from 'react-native';

import { MessageBubble } from '@/components/kilo-chat/message-bubble';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createMessageListKeyboardScrollScheduler,
  createMessageListNewestScrollScheduler,
} from './message-list-keyboard-scroll';
import {
  isMessageListAtBottom,
  messageListNewestScrollKey,
  shouldScrollToNewestAfterMessagesChange,
} from './message-list-scroll-state';
import { type MessageAuthorMember, resolveMessageAuthorLabel } from './message-presentation';

const listStyle = { flex: 1 } satisfies ViewStyle;

type Props = {
  client: KiloChatClient;
  conversationId: string;
  messages: Message[];
  currentUserId: string | null;
  members?: readonly MessageAuthorMember[];
  botName?: string | null;
  fetchOlder?: () => void;
  isFetchingOlder: boolean;
  pendingAction: PendingAction | null;
  scrollToNewestRequest: number;
  onExecuteAction: (message: Message, groupId: string, value: ExecApprovalDecision) => void;
  onReactionPress: (message: Message, emoji: string) => void;
  onLongPressMessage?: (m: Message) => void;
  onSwipeReplyMessage?: (m: Message) => void;
};

export function MessageList({
  client,
  conversationId,
  messages,
  currentUserId,
  members,
  botName,
  fetchOlder,
  isFetchingOlder,
  pendingAction,
  scrollToNewestRequest,
  onExecuteAction,
  onReactionPress,
  onLongPressMessage,
  onSwipeReplyMessage,
}: Props) {
  const listRef = useRef<FlashListRef<Message>>(null);
  const scrollOffsetRef = useRef(0);
  const contentHeightRef = useRef(0);
  const initialNewestMessage = messages.at(-1);
  const newestMessageKeyRef = useRef(messageListNewestScrollKey(initialNewestMessage));
  const isAtBottomRef = useRef(true);
  const isAutoFollowingNewestRef = useRef(true);
  const scrollToNewestRequestRef = useRef(scrollToNewestRequest);
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
  const newestScrollScheduler = useMemo(
    () =>
      createMessageListNewestScrollScheduler({
        scrollToEnd: params => {
          listRef.current?.scrollToEnd(params);
        },
      }),
    []
  );
  // useMessages returns messages oldest-to-newest.
  // FlashList v2 does not support `inverted`; instead we use maintainVisibleContentPosition
  // with startRenderingFromBottom, which expects chronological order.
  const chronological = messages;
  const newestMessage = chronological.at(-1);
  const messageMap = useMemo(
    () => new Map(chronological.map(message => [message.id, message])),
    [chronological]
  );
  const scrollToNewest = useCallback(() => {
    isAutoFollowingNewestRef.current = true;
    isAtBottomRef.current = true;
    newestScrollScheduler.schedule();
  }, [newestScrollScheduler]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;
    contentHeightRef.current = contentSize.height;
    const nextIsAtBottom = isMessageListAtBottom({
      contentHeight: contentSize.height,
      viewportHeight: layoutMeasurement.height,
      offsetY: contentOffset.y,
    });
    isAtBottomRef.current = nextIsAtBottom;
    if (nextIsAtBottom) {
      isAutoFollowingNewestRef.current = true;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    isAutoFollowingNewestRef.current = false;
  }, []);

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const previousContentHeight = contentHeightRef.current;
      contentHeightRef.current = height;
      if (height > previousContentHeight && isAutoFollowingNewestRef.current) {
        scrollToNewest();
      }
    },
    [scrollToNewest]
  );

  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', event => {
      keyboardScrollScheduler.schedule(event.endCoordinates.height);
    });

    return () => {
      subscription.remove();
      keyboardScrollScheduler.cancel();
      newestScrollScheduler.cancel();
    };
  }, [keyboardScrollScheduler, newestScrollScheduler]);

  useEffect(() => {
    const newestMessageKey = messageListNewestScrollKey(newestMessage);
    const shouldScroll = shouldScrollToNewestAfterMessagesChange({
      isAutoFollowingNewest: isAutoFollowingNewestRef.current,
      newestMessageKey,
      previousNewestMessageKey: newestMessageKeyRef.current,
      wasAtBottom: isAtBottomRef.current,
    });
    newestMessageKeyRef.current = newestMessageKey;
    if (shouldScroll) {
      scrollToNewest();
    }
  }, [newestMessage, scrollToNewest]);

  useEffect(() => {
    if (scrollToNewestRequestRef.current === scrollToNewestRequest) {
      return;
    }
    scrollToNewestRequestRef.current = scrollToNewestRequest;
    scrollToNewest();
  }, [scrollToNewest, scrollToNewestRequest]);

  return (
    <View className="flex-1 bg-background">
      <FlashList
        ref={listRef}
        style={listStyle}
        data={chronological}
        renderItem={({ item, index }) => {
          // In chronological order, the previous message in time is data[index - 1].
          // showAuthor is true when the sender changes relative to the prior message,
          // or when this is the oldest message (index 0).
          const previousItem = chronological[index - 1];
          const showAuthor = previousItem === undefined || previousItem.senderId !== item.senderId;

          return (
            <MessageBubble
              client={client}
              conversationId={conversationId}
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
        onScrollBeginDrag={handleScrollBeginDrag}
        onContentSizeChange={handleContentSizeChange}
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
    </View>
  );
}
