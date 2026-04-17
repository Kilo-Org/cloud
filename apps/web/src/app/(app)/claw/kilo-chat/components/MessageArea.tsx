'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Message, ContentBlock } from '@kilocode/kilo-chat';
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useMessageCacheUpdater,
} from '../hooks/useMessages';
import { useSSE } from '../hooks/useSSE';
import { useTypingSender, useTypingState } from '../hooks/useTyping';
import { useConversationDetail, useRenameConversation } from '../hooks/useConversations';
import { toast } from 'sonner';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { BotStatus } from './BotStatus';
import { KiloChatApiError } from '@kilocode/kilo-chat';

type MessageAreaProps = {
  conversationId: string;
  currentUserId: string;
  getToken: () => Promise<string>;
  instanceStatus: string | null;
};

export function MessageArea({
  conversationId,
  currentUserId,
  getToken,
  instanceStatus,
}: MessageAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [renameText, setRenameText] = useState('');

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    getToken,
    conversationId
  );
  const messages = data?.messages ?? [];

  const conversationDetail = useConversationDetail(getToken, conversationId);
  const renameConversation = useRenameConversation(getToken);
  const sendMessage = useSendMessage(getToken, currentUserId);
  const editMessage = useEditMessage(getToken);
  const deleteMessage = useDeleteMessage(getToken);

  const updateCache = useMessageCacheUpdater(conversationId);
  const { typingMembers, handleTypingEvent, clearTypingForMember } = useTypingState(currentUserId);
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
          if (event.type === 'message.created') {
            clearTypingForMember((event.data as { senderId: string }).senderId);
          }
          updateCache(event);
        }
      },
      [handleTypingEvent, clearTypingForMember, updateCache]
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
    sendMessage.mutate(
      {
        conversationId,
        content: [{ type: 'text', text }],
        inReplyToMessageId,
      },
      { onError: () => toast.error('Failed to send message') }
    );
  }

  function handleEdit(messageId: string, content: ContentBlock[], version: number) {
    editMessage.mutate(
      { messageId, conversationId, content, version },
      {
        onError: err => {
          if (err instanceof KiloChatApiError && err.status === 409) {
            toast.error('Message was edited by someone else — please try again');
          } else {
            toast.error('Failed to edit message');
          }
        },
      }
    );
  }

  function handleDelete(messageId: string) {
    setPendingDeleteId(messageId);
  }

  function handleConfirmDelete(messageId: string) {
    deleteMessage.mutate(
      { messageId, conversationId },
      { onError: () => toast.error('Failed to delete message') }
    );
    setPendingDeleteId(null);
  }

  function handleCancelDelete() {
    setPendingDeleteId(null);
  }

  const messageMap = new Map(messages.map(m => [m.id, m]));

  const title = conversationDetail.data?.title ?? 'Untitled';

  function handleTitleClick() {
    setRenameText(title);
    setIsRenamingTitle(true);
  }

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const trimmed = renameText.trim();
      if (trimmed) {
        renameConversation.mutate(
          { conversationId, title: trimmed },
          { onError: () => toast.error('Failed to rename conversation') }
        );
      }
      setIsRenamingTitle(false);
    } else if (e.key === 'Escape') {
      setIsRenamingTitle(false);
    }
  }

  function handleRenameBlur() {
    setIsRenamingTitle(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        {isRenamingTitle ? (
          <input
            autoFocus
            className="text-sm font-medium bg-transparent border-b border-border outline-none w-full max-w-xs"
            value={renameText}
            onChange={e => setRenameText(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
          />
        ) : (
          <h2
            className="text-sm font-medium cursor-pointer hover:opacity-70 transition-opacity"
            onClick={handleTitleClick}
            title="Click to rename"
          >
            {title}
          </h2>
        )}
        <BotStatus instanceStatus={instanceStatus} />
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
