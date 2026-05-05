import { type Message } from '@kilocode/kilo-chat';

const MESSAGE_LIST_BOTTOM_THRESHOLD_PX = 24;

export function isMessageListAtBottom({
  contentHeight,
  viewportHeight,
  offsetY,
}: {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
}): boolean {
  return offsetY + viewportHeight >= contentHeight - MESSAGE_LIST_BOTTOM_THRESHOLD_PX;
}

export function shouldScrollToNewestAfterMessagesChange({
  isAutoFollowingNewest = false,
  newestMessageKey,
  previousNewestMessageKey,
  wasAtBottom,
}: {
  isAutoFollowingNewest?: boolean;
  newestMessageKey: string | null;
  previousNewestMessageKey: string | null;
  wasAtBottom: boolean;
}): boolean {
  return (
    newestMessageKey !== null &&
    newestMessageKey !== previousNewestMessageKey &&
    (wasAtBottom || isAutoFollowingNewest)
  );
}

export function messageListNewestScrollKey(message: Message | undefined): string | null {
  if (!message) {
    return null;
  }
  return JSON.stringify({
    id: message.id,
    content: message.content,
    updatedAt: message.updatedAt,
    clientUpdatedAt: message.clientUpdatedAt,
    deleted: message.deleted,
    deliveryFailed: message.deliveryFailed,
  });
}
