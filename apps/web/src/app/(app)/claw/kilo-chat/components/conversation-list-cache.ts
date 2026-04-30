import type { ConversationListItem } from '@kilocode/kilo-chat';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { conversationsKey } from '@kilocode/kilo-chat-hooks';
import type { ConversationListInfiniteData } from '../hooks/useConversations';

type ConversationUpdater = (conversation: ConversationListItem) => ConversationListItem;

export function moveConversationToFirstPage(
  data: ConversationListInfiniteData | undefined,
  conversationId: string,
  updateConversation: ConversationUpdater
): ConversationListInfiniteData | undefined {
  if (!data) return data;

  let movedConversation: ConversationListItem | null = null;
  const pages = data.pages.map(page => {
    const nextConversations: ConversationListItem[] = [];
    for (const conversation of page.conversations) {
      if (conversation.conversationId === conversationId) {
        movedConversation = updateConversation(conversation);
        continue;
      }
      nextConversations.push(conversation);
    }
    return { ...page, conversations: nextConversations };
  });

  const firstPage = pages[0];
  if (!movedConversation || !firstPage) return data;

  return {
    ...data,
    pages: [
      { ...firstPage, conversations: [movedConversation, ...firstPage.conversations] },
      ...pages.slice(1),
    ],
  };
}

export function conversationListQueryKeyForInstanceEvent(ctx: string, sandboxId: string | null) {
  if (!sandboxId) return null;
  if (ctx !== kiloclawInstanceContext(sandboxId)) return null;
  return conversationsKey(sandboxId);
}
