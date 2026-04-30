import { type ConversationListInfiniteData } from '@kilocode/kilo-chat-hooks';

export function isConversationOnFirstPage(
  data: ConversationListInfiniteData | undefined,
  conversationId: string
): boolean {
  return (
    data?.pages[0]?.conversations.some(
      conversation => conversation.conversationId === conversationId
    ) ?? false
  );
}

export function shouldApplyConversationRead(
  currentUserId: string | null,
  memberId: string
): boolean {
  return currentUserId !== null && currentUserId === memberId;
}
