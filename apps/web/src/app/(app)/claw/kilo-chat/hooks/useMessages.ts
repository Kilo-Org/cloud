export {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useAddReaction,
  useRemoveReaction,
  useExecuteAction,
} from '@kilocode/kilo-chat-hooks';
export type { SendMessageVariables } from '@kilocode/kilo-chat-hooks';

import { useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  ReactionSummary,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ActionDeliveryFailedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from '@kilocode/kilo-chat';
import { useEffect } from 'react';
import { kiloclawConversationContext } from '@kilocode/event-service';
import { toast } from 'sonner';

function applyReactionAdded(
  reactions: ReactionSummary[],
  emoji: string,
  memberId: string
): ReactionSummary[] {
  const existing = reactions.find(r => r.emoji === emoji);
  if (existing) {
    if (existing.memberIds.includes(memberId)) return reactions;
    return reactions.map(r =>
      r.emoji === emoji ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, memberId] } : r
    );
  }
  return [...reactions, { emoji, count: 1, memberIds: [memberId] }];
}

function applyReactionRemoved(
  reactions: ReactionSummary[],
  emoji: string,
  memberId: string
): ReactionSummary[] {
  return reactions
    .map(r => {
      if (r.emoji !== emoji) return r;
      const memberIds = r.memberIds.filter(id => id !== memberId);
      return { ...r, count: memberIds.length, memberIds };
    })
    .filter(r => r.count > 0);
}

/**
 * Subscribes to real-time kilo-chat events on the shared client and applies
 * them to the React Query message cache for the active conversation.
 *
 * Each subscription receives the fully validated typed payload from the
 * client (Zod-checked inside `KiloChatClient.on`), so no casts are needed.
 *
 * Event Service delivers every subscribed context to every handler, so we
 * also validate `ctx` against the expected conversation context before
 * mutating the cache. This protects against stale subscriptions, context
 * leaks, or server-side routing drift.
 */
export function useMessageCacheUpdater(
  client: KiloChatClient,
  sandboxId: string | null,
  conversationId: string | null,
  // Called with the event context and sender id when a human sender's
  // message lands. Bots stream tokens through message.created events and
  // end their own typing state via explicit typing.stopped, so we must not
  // clear on bot messages or the indicator disappears mid-stream.
  onHumanMessageCreated?: (ctx: string, senderId: string) => void
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!conversationId || !sandboxId) return;
    const queryKey = ['kilo-chat', 'messages', conversationId];
    const expectedContext = kiloclawConversationContext(sandboxId, conversationId);

    const onCreated = (ctx: string, e: MessageCreatedEvent) => {
      if (ctx !== expectedContext) return;
      if (!e.senderId.startsWith('bot:')) {
        onHumanMessageCreated?.(ctx, e.senderId);
      }
      const newMessage: Message = {
        id: e.messageId,
        senderId: e.senderId,
        content: e.content,
        inReplyToMessageId: e.inReplyToMessageId,
        updatedAt: null,
        clientUpdatedAt: null,
        deleted: false,
        deliveryFailed: false,
        reactions: [],
      };
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        // Skip if this messageId already exists
        for (const page of old.pages) {
          if (page.some(msg => msg.id === e.messageId)) return old;
        }
        // Replace the matching pending optimistic message if clientId correlates
        if (e.clientId) {
          const pendingId = `pending-${e.clientId}`;
          for (const page of old.pages) {
            if (page.some(msg => msg.id === pendingId)) {
              return {
                ...old,
                pages: old.pages.map(p => p.map(msg => (msg.id === pendingId ? newMessage : msg))),
              };
            }
          }
        }
        const firstPage = old.pages[0] ?? [];
        return { ...old, pages: [[newMessage, ...firstPage], ...old.pages.slice(1)] };
      });
    };

    const onUpdated = (ctx: string, e: MessageUpdatedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg =>
              msg.id === e.messageId
                ? {
                    ...msg,
                    content: e.content,
                    clientUpdatedAt: e.clientUpdatedAt,
                  }
                : msg
            )
          ),
        };
      });
    };

    const onDeleted = (ctx: string, e: MessageDeletedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg => (msg.id === e.messageId ? { ...msg, deleted: true } : msg))
          ),
        };
      });
    };

    const onDeliveryFailed = (ctx: string, e: MessageDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg => (msg.id === e.messageId ? { ...msg, deliveryFailed: true } : msg))
          ),
        };
      });
    };

    const onActionFailed = (ctx: string, e: ActionDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg => {
              if (msg.id !== e.messageId) return msg;
              return {
                ...msg,
                content: msg.content.map(block => {
                  if (block.type !== 'actions') return block;
                  if (block.groupId !== e.groupId) return block;
                  return { ...block, resolved: undefined };
                }),
              };
            })
          ),
        };
      });
      toast.error("Couldn't reach the bot — please try again");
    };

    const onReactionAdded = (ctx: string, e: ReactionAddedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg =>
              msg.id !== e.messageId
                ? msg
                : { ...msg, reactions: applyReactionAdded(msg.reactions, e.emoji, e.memberId) }
            )
          ),
        };
      });
    };

    const onReactionRemoved = (ctx: string, e: ReactionRemovedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg =>
              msg.id !== e.messageId
                ? msg
                : {
                    ...msg,
                    reactions: applyReactionRemoved(msg.reactions, e.emoji, e.memberId),
                  }
            )
          ),
        };
      });
    };

    const offs = [
      client.onMessageCreated(onCreated),
      client.onMessageUpdated(onUpdated),
      client.onMessageDeleted(onDeleted),
      client.onMessageDeliveryFailed(onDeliveryFailed),
      client.onActionDeliveryFailed(onActionFailed),
      client.onReactionAdded(onReactionAdded),
      client.onReactionRemoved(onReactionRemoved),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, sandboxId, conversationId, queryClient, onHumanMessageCreated]);
}
