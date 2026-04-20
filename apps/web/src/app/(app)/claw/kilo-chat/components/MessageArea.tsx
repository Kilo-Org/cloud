'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ulid } from 'ulid';
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
import { MessageCircle, ArrowDown } from 'lucide-react';

type MessageAreaProps = {
  conversationId: string;
  currentUserId: string;
  getToken: () => Promise<string>;
  instanceStatus: string | null;
  assistantName: string | null;
};

export function MessageArea({
  conversationId,
  currentUserId,
  getToken,
  instanceStatus,
  assistantName,
}: MessageAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
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
  const sendMessage = useSendMessage(getToken, conversationId, currentUserId);
  const editMessage = useEditMessage(getToken, conversationId);
  const deleteMessage = useDeleteMessage(getToken, conversationId);

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
        } else if (event.type === 'message.delivery_failed') {
          updateCache(event);
          toast.error('Message could not be delivered to the bot');
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

  // Auto-scroll whenever content height changes (new messages or streaming updates)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (autoScrollRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // Track scroll position to detect user scrolling away from bottom
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;

    // Load more on scroll to top
    if (el.scrollTop < 50 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (isNearBottom) {
      autoScrollRef.current = true;
      setShowScrollButton(false);
    } else {
      autoScrollRef.current = false;
      setShowScrollButton(true);
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    setShowScrollButton(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  function handleSend(text: string, inReplyToMessageId?: string) {
    autoScrollRef.current = true;
    setShowScrollButton(false);
    sendMessage.mutate(
      {
        conversationId,
        content: [{ type: 'text', text }],
        inReplyToMessageId,
        clientId: ulid(),
      },
      { onError: () => toast.error('Failed to send message') }
    );
  }

  function handleEdit(messageId: string, content: ContentBlock[]) {
    editMessage.mutate(
      { messageId, conversationId, content, timestamp: Date.now() },
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
      {
        onSettled: () => setPendingDeleteId(null),
        onError: () => toast.error('Failed to delete message'),
      }
    );
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
        <input
          ref={renamingTitleRef => {
            if (isRenamingTitle && renamingTitleRef) renamingTitleRef.focus();
          }}
          readOnly={!isRenamingTitle}
          className={`text-sm font-medium bg-transparent outline-none min-w-0 flex-1 mr-2 ${
            isRenamingTitle
              ? 'border-b border-current/20'
              : 'cursor-pointer hover:opacity-70 transition-opacity border-b border-transparent'
          }`}
          value={isRenamingTitle ? renameText : title}
          onChange={e => setRenameText(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={() => {
            if (!isRenamingTitle) handleTitleClick();
          }}
          title={isRenamingTitle ? undefined : 'Click to rename'}
        />
        <BotStatus instanceStatus={instanceStatus} />
      </div>

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto py-4" onScroll={handleScroll}>
          {isFetchingNextPage && (
            <div className="text-muted-foreground py-2 text-center text-xs">
              Loading older messages...
            </div>
          )}
          {messages.length === 0 && !isFetchingNextPage && (
            <div className="flex h-full flex-col items-center justify-center px-6">
              <div className="border-border bg-muted/50 flex flex-col items-center gap-3 rounded-lg border px-8 py-6">
                <MessageCircle className="text-muted-foreground/60 h-8 w-8" />
                <p className="text-muted-foreground text-sm">
                  Ask {assistantName ?? 'KiloClaw'} to draft a message, make a checklist,
                  <br />
                  or help you think through a decision.
                </p>
              </div>
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
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="bg-muted hover:bg-accent border-border absolute bottom-0 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border shadow-md cursor-pointer transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Typing indicator — fixed height to prevent layout shift */}
      <TypingIndicator typingMembers={typingMembers} />

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
