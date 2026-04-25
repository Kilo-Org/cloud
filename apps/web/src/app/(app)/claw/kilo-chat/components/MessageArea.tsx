'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ulid } from 'ulid';
import type { Message, ContentBlock, ExecApprovalDecision } from '@kilocode/kilo-chat';
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useMessageCacheUpdater,
  useAddReaction,
  useRemoveReaction,
  useExecuteAction,
} from '../hooks/useMessages';
import { useConversationContext } from '../hooks/useEventService';
import { useTypingSender, useTypingState } from '../hooks/useTyping';
import {
  useConversationDetail,
  useRenameConversation,
  useMarkConversationRead,
} from '../hooks/useConversations';
import { useKiloChatContext } from './KiloChatLayout';
import { toast } from 'sonner';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { BotStatus } from './BotStatus';
import { ContextUsageRing } from './ContextUsageRing';
import { KiloChatApiError } from '@kilocode/kilo-chat';
import { MessageCircle, ArrowDown } from 'lucide-react';

type MessageAreaProps = {
  conversationId: string;
};

export function MessageArea({ conversationId }: MessageAreaProps) {
  const {
    currentUserId,
    instanceStatus,
    assistantName,
    sandboxId,
    eventService,
    kiloChatClient,
    botPresence,
    botContext,
  } = useKiloChatContext();
  const presence = sandboxId ? botPresence(sandboxId) : undefined;
  const ctxUsage = botContext(conversationId);
  const queryClient = useQueryClient();

  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [renameText, setRenameText] = useState('');

  // Subscribe to this conversation's events via the event-service WebSocket
  useConversationContext(eventService, sandboxId, conversationId);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    kiloChatClient,
    conversationId
  );
  const messages = data?.messages ?? [];

  const conversationDetail = useConversationDetail(kiloChatClient, conversationId);
  const renameConversation = useRenameConversation(kiloChatClient);
  const sendMessage = useSendMessage(kiloChatClient, conversationId, currentUserId);
  const editMessage = useEditMessage(kiloChatClient, conversationId);
  const deleteMessage = useDeleteMessage(kiloChatClient, conversationId);
  const addReaction = useAddReaction(kiloChatClient, conversationId, currentUserId);
  const removeReaction = useRemoveReaction(kiloChatClient, conversationId, currentUserId);
  const executeAction = useExecuteAction(kiloChatClient, conversationId, currentUserId);

  const updateCache = useMessageCacheUpdater(conversationId);
  const { typingMembers, handleTypingEvent, clearTypingForMember } = useTypingState(currentUserId);
  const sendTyping = useTypingSender(kiloChatClient, conversationId);

  const markRead = useMarkConversationRead(kiloChatClient);
  const markReadRef = useRef(markRead.mutate);
  markReadRef.current = markRead.mutate;
  const lastMarkedRef = useRef<string | null>(null);

  // Mark conversation as read when opened
  useEffect(() => {
    if (lastMarkedRef.current === conversationId) return;
    lastMarkedRef.current = conversationId;
    markReadRef.current(conversationId);
  }, [conversationId]);

  // Register typed event handlers on the shared kiloChatClient
  useEffect(() => {
    const offs = [
      kiloChatClient.onMessageCreated((_ctx, data) => {
        updateCache({ type: 'message.created', data });
      }),
      kiloChatClient.onMessageUpdated((_ctx, data) => {
        updateCache({ type: 'message.updated', data });
      }),
      kiloChatClient.onMessageDeleted((_ctx, data) => {
        updateCache({ type: 'message.deleted', data });
      }),
      kiloChatClient.onMessageDeliveryFailed((_ctx, data) => {
        updateCache({ type: 'message.delivery_failed', data });
        toast.error('Message could not be delivered to the bot');
      }),
      kiloChatClient.onActionDeliveryFailed((_ctx, data) => {
        updateCache({ type: 'action.delivery_failed', data });
      }),
      kiloChatClient.onTyping((_ctx, data) => {
        handleTypingEvent(data);
      }),
      kiloChatClient.onTypingStop((_ctx, data) => {
        clearTypingForMember(data.memberId);
      }),
      kiloChatClient.onReactionAdded((_ctx, data) => {
        updateCache({ type: 'reaction.added', data });
      }),
      kiloChatClient.onReactionRemoved((_ctx, data) => {
        updateCache({ type: 'reaction.removed', data });
      }),
    ];
    return () => offs.forEach(off => off());
  }, [kiloChatClient, updateCache, handleTypingEvent, clearTypingForMember, conversationId]);

  // Refetch messages on WebSocket reconnect (events may have been missed)
  useEffect(() => {
    return eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'messages', conversationId] });
    });
  }, [eventService, queryClient, conversationId]);

  // Auto-scroll whenever content height changes (new messages or streaming updates)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (autoScrollRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el, { childList: true, subtree: true });
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

  const handleEdit = useCallback(
    (messageId: string, content: ContentBlock[]) => {
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
    },
    [editMessage.mutate, conversationId]
  );

  const handleDelete = useCallback((messageId: string) => {
    setPendingDeleteId(messageId);
  }, []);

  const handleConfirmDelete = useCallback(
    (messageId: string) => {
      deleteMessage.mutate(
        { messageId, conversationId },
        {
          onSettled: () => setPendingDeleteId(null),
          onError: () => toast.error('Failed to delete message'),
        }
      );
    },
    [deleteMessage.mutate, conversationId]
  );

  const handleCancelDelete = useCallback(() => {
    setPendingDeleteId(null);
  }, []);

  const handleAddReaction = useCallback(
    (messageId: string, emoji: string) => {
      addReaction.mutate(
        { messageId, emoji },
        { onError: () => toast.error('Failed to add reaction') }
      );
    },
    [addReaction.mutate]
  );

  const handleRemoveReaction = useCallback(
    (messageId: string, emoji: string) => {
      removeReaction.mutate(
        { messageId, emoji },
        { onError: () => toast.error('Failed to remove reaction') }
      );
    },
    [removeReaction.mutate]
  );

  const handleExecuteAction = useCallback(
    (messageId: string, groupId: string, value: ExecApprovalDecision) => {
      executeAction.mutate(
        { messageId, groupId, value },
        { onError: () => toast.error('Failed to execute action') }
      );
    },
    [executeAction.mutate]
  );

  const messageMap = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

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
      setRenameText('');
      setIsRenamingTitle(false);
    }
  }

  function handleRenameBlur() {
    const trimmed = renameText.trim();
    if (trimmed && trimmed !== title) {
      renameConversation.mutate(
        { conversationId, title: trimmed },
        { onError: () => toast.error('Failed to rename conversation') }
      );
    }
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
        <div className="flex items-center gap-3">
          {ctxUsage && (
            <ContextUsageRing
              contextTokens={ctxUsage.contextTokens}
              contextWindow={ctxUsage.contextWindow}
            />
          )}
          <BotStatus instanceStatus={instanceStatus} presence={presence} />
        </div>
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
              onAddReaction={handleAddReaction}
              onRemoveReaction={handleRemoveReaction}
              onExecuteAction={handleExecuteAction}
              actionPending={executeAction.isPending}
              currentUserId={currentUserId}
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
      <TypingIndicator typingMembers={typingMembers} assistantName={assistantName ?? undefined} />

      {/* Input */}
      <MessageInput
        key={conversationId}
        onSend={handleSend}
        onTyping={sendTyping}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        assistantName={assistantName ?? undefined}
        currentUserId={currentUserId}
      />
    </div>
  );
}
