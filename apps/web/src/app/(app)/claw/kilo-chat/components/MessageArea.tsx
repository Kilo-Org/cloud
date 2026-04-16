'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Message, ContentBlock } from '../types';
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useMessageCacheUpdater,
} from '../hooks/useMessages';
import { useSSE } from '../hooks/useSSE';
import { useTypingSender, useTypingState } from '../hooks/useTyping';
import { useConversationDetail } from '../hooks/useConversations';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { BotStatus } from './BotStatus';
import { KiloChatApiError } from '../hooks/useKiloChatClient';

type MessageAreaProps = {
  conversationId: string;
  currentUserId: string;
  getToken: () => Promise<string>;
};

export function MessageArea({ conversationId, currentUserId, getToken }: MessageAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    getToken,
    conversationId
  );
  const messages = data?.messages ?? [];

  const conversationDetail = useConversationDetail(getToken, conversationId);
  const sendMessage = useSendMessage(getToken);
  const editMessage = useEditMessage(getToken);
  const deleteMessage = useDeleteMessage(getToken);

  const updateCache = useMessageCacheUpdater(conversationId);
  const { typingMembers, handleTypingEvent } = useTypingState(currentUserId);
  const sendTyping = useTypingSender(getToken, conversationId);

  // SSE connection
  useSSE({
    conversationId,
    getToken,
    onEvent: useCallback(
      event => {
        if (event.type === 'typing') {
          handleTypingEvent(event.data);
        } else {
          updateCache(event);
        }
      },
      [handleTypingEvent, updateCache]
    ),
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  // Load more on scroll to top
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < 50 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }

  function handleSend(text: string, inReplyToMessageId?: string) {
    sendMessage.mutate({
      conversationId,
      content: [{ type: 'text', text }],
      inReplyToMessageId,
    });
  }

  function handleEdit(messageId: string, content: ContentBlock[], version: number) {
    editMessage.mutate(
      { messageId, conversationId, content, version },
      {
        onError: err => {
          if (err instanceof KiloChatApiError && err.status === 409) {
            // Version conflict — could show toast here
          }
        },
      }
    );
  }

  function handleDelete(messageId: string) {
    setPendingDeleteId(messageId);
  }

  function handleConfirmDelete(messageId: string) {
    deleteMessage.mutate({ messageId, conversationId });
    setPendingDeleteId(null);
  }

  function handleCancelDelete() {
    setPendingDeleteId(null);
  }

  const messageMap = new Map(messages.map(m => [m.id, m]));

  const botIsTyping = Array.from(typingMembers.keys()).some(id => id.startsWith('bot:'));

  const title = conversationDetail.data?.title ?? 'Conversation';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <BotStatus isTyping={botIsTyping} />
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4" onScroll={handleScroll}>
        {isFetchingNextPage && (
          <div className="text-muted-foreground py-2 text-center text-xs">
            Loading older messages...
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            isOwn={msg.senderId === currentUserId}
            replyToMessage={
              msg.inReplyToMessageId ? (messageMap.get(msg.inReplyToMessageId) ?? null) : null
            }
            pendingDeleteId={pendingDeleteId}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onConfirmDelete={handleConfirmDelete}
            onCancelDelete={handleCancelDelete}
            onReply={setReplyingTo}
          />
        ))}
        <TypingIndicator typingMembers={typingMembers} />
      </div>

      {/* Input */}
      <MessageInput
        onSend={handleSend}
        onTyping={sendTyping}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
      />
    </div>
  );
}
