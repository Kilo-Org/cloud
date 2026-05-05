'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ulid } from 'ulid';
import type {
  Message,
  ContentBlock,
  EditMessageRequest,
  ExecApprovalDecision,
} from '@kilocode/kilo-chat';
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useMessageCacheUpdater,
  useAddReaction,
  useRemoveReaction,
  useExecuteAction,
  latestMarkReadMessageId,
} from '../hooks/useMessages';
import {
  kiloclawConversationContext,
  presenceContextForConversation,
} from '@kilocode/event-service';
import { useDocumentVisible } from '@/hooks/useDocumentVisible';
import { useTypingSender, useTypingState } from '../hooks/useTyping';
import {
  createMarkReadState,
  finishMarkReadAttempt,
  useConversationDetail,
  useRenameConversation,
  useMarkConversationRead,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
} from '../hooks/useConversations';
import { useKiloChatContext } from './kiloChatContext';
import { toast } from 'sonner';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { BotStatus, computeBotDisplay, useNowTicker } from './BotStatus';
import { ContextUsageRing } from './ContextUsageRing';
import { useBotStatus } from '../hooks/useBotStatus';
import { useConversationStatus } from '../hooks/useConversationStatus';
import {
  clearMarkReadRetry,
  createMarkReadRetryState,
  scheduleMarkReadRetry,
  usePresenceSubscription,
} from '@kilocode/kilo-chat-hooks';
import {
  KiloChatApiError,
  formatKiloChatError,
  CONVERSATION_TITLE_MAX_CHARS,
} from '@kilocode/kilo-chat';
import {
  clearPendingAction,
  pendingActionGroupIdForMessage,
  tryStartPendingAction,
  type PendingAction,
} from '@kilocode/kilo-chat-hooks';
import {
  applyPrependScrollAnchor,
  capturePrependScrollAnchor,
  type PrependScrollAnchorSnapshot,
} from './message-scroll-anchor';
import { MessageCircle, ArrowDown } from 'lucide-react';

type MessageAreaProps = {
  conversationId: string;
};

function toEditableContent(content: ContentBlock[]): EditMessageRequest['content'] {
  return content.map(block => {
    if (block.type === 'actions') {
      return {
        type: 'actions',
        groupId: block.groupId,
        actions: block.actions,
      };
    }
    return block;
  });
}

export function MessageArea({ conversationId }: MessageAreaProps) {
  const { currentUserId, instanceStatus, assistantName, sandboxId, eventService, kiloChatClient } =
    useKiloChatContext();
  const botStatus = useBotStatus();
  const presence = botStatus ? { online: botStatus.online, lastAt: botStatus.at } : undefined;
  const ctxUsage = useConversationStatus(conversationId);
  const queryClient = useQueryClient();

  // Re-render every 10 s so the send-gate reacts to presence going stale
  // (no `bot.status` heartbeat for >30 s) without requiring user input. The
  // ticker is scoped here so memoized MessageBubble children are not
  // invalidated.
  const now = useNowTicker(10_000);
  const botDisplay = computeBotDisplay({ instanceStatus, presence, now });
  // Treat `idle` as sendable: idle just means no heartbeat in the last 30 s,
  // which is a normal steady state. Only block sends once the bot is clearly
  // `offline` (>90 s stale, explicitly offline, or instance not running) or
  // `unknown` (no presence data at all).
  const botCanSend = botDisplay.state === 'online' || botDisplay.state === 'idle';
  const canSend = currentUserId !== null && botCanSend;
  const sendDisabledReason = canSend
    ? null
    : currentUserId === null
      ? 'Loading user...'
      : botDisplay.state === 'unknown'
        ? 'Waiting for bot status…'
        : 'Bot is offline — messages will resume when it reconnects';

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const pendingPrependScrollAnchorRef = useRef<PrependScrollAnchorSnapshot | null>(null);
  const wasFetchingNextPageRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const pendingActionRef = useRef<PendingAction | null>(null);

  const visible = useDocumentVisible();

  // Subscribe to this conversation's chat-event stream while the conversation
  // is open. Not gated on visibility — we want incoming messages to land in
  // the cache even when the tab is hidden.
  usePresenceSubscription(
    sandboxId && conversationId ? kiloclawConversationContext(sandboxId, conversationId) : null,
    Boolean(sandboxId && conversationId)
  );

  // Signal our own presence on this conversation. Gated on visibility so we
  // only appear "viewing" while the tab is actually in the foreground.
  usePresenceSubscription(
    sandboxId && conversationId ? presenceContextForConversation(sandboxId, conversationId) : null,
    Boolean(sandboxId && conversationId) && visible
  );

  // Event Service delivers subscribed contexts to every handler, so each
  // handler must validate the incoming `ctx` against this string before
  // applying changes to the active conversation's state.
  const expectedContext = sandboxId ? kiloclawConversationContext(sandboxId, conversationId) : null;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(
    kiloChatClient,
    conversationId
  );
  const messages = data?.messages ?? [];
  const latestMessageId = latestMarkReadMessageId(messages);

  const conversationDetail = useConversationDetail(kiloChatClient, conversationId);
  const renameConversation = useRenameConversation(kiloChatClient);
  const sendMessage = useSendMessage(kiloChatClient, conversationId, currentUserId);
  const editMessage = useEditMessage(kiloChatClient, conversationId);
  const deleteMessage = useDeleteMessage(kiloChatClient, conversationId);
  const addReaction = useAddReaction(kiloChatClient, conversationId, currentUserId);
  const removeReaction = useRemoveReaction(kiloChatClient, conversationId, currentUserId);
  const executeAction = useExecuteAction(kiloChatClient, conversationId, currentUserId);

  const { typingMembers, handleTypingEvent, clearTypingForMember } = useTypingState(
    currentUserId,
    expectedContext
  );
  // When a human message arrives, end their typing indicator immediately
  // rather than waiting for an explicit typing.stopped event (which can
  // arrive late and let "Name is typing…" linger above the new message).
  // Bots are excluded inside the hook because their streaming uses
  // message.created for every token chunk and relies on typing.stopped to
  // signal stream completion.
  const handleActionFailed = useCallback(() => {
    toast.error("Couldn't reach the bot — please try again");
  }, []);
  const handleMessageDeliveryFailed = useCallback(() => {
    toast.error('Message could not be delivered to the bot');
  }, []);
  useMessageCacheUpdater(
    kiloChatClient,
    sandboxId,
    conversationId,
    clearTypingForMember,
    handleActionFailed,
    handleMessageDeliveryFailed
  );
  const sendTyping = useTypingSender(kiloChatClient, conversationId);

  const markRead = useMarkConversationRead(kiloChatClient);
  const markReadStateRef = useRef(createMarkReadState());
  const markReadRetryStateRef = useRef(createMarkReadRetryState());
  const currentMarkReadMarker =
    latestMessageId === null ? null : `${conversationId}:${latestMessageId}`;
  const currentMarkReadMarkerRef = useRef<string | null>(currentMarkReadMarker);
  const visibleRef = useRef(visible);
  const markCurrentConversationReadRef = useRef<() => void>(() => {});
  currentMarkReadMarkerRef.current = currentMarkReadMarker;
  visibleRef.current = visible;

  const markCurrentConversationRead = useCallback(() => {
    if (latestMessageId === null || currentMarkReadMarker === null) {
      return;
    }
    const marker = currentMarkReadMarker;
    const state = markReadStateRef.current;
    if (!shouldStartMarkReadAttempt(state, marker)) {
      return;
    }
    startMarkReadAttempt(state, marker);
    markRead.mutate(
      { sandboxId, conversationId, lastSeenMessageId: latestMessageId },
      {
        onSuccess: () => {
          succeedMarkReadAttempt(state, marker);
          clearMarkReadRetry(markReadRetryStateRef.current);
        },
        onSettled: () => {
          finishMarkReadAttempt(state, marker);
          if (state.lastSucceededMarker !== marker) {
            scheduleMarkReadRetry(markReadRetryStateRef.current, {
              marker,
              currentMarker: () => currentMarkReadMarkerRef.current,
              isActive: () => visibleRef.current,
              lastSucceededMarker: () => markReadStateRef.current.lastSucceededMarker,
              retry: () => markCurrentConversationReadRef.current(),
            });
          }
        },
      }
    );
  }, [conversationId, currentMarkReadMarker, latestMessageId, markRead.mutate, sandboxId]);
  markCurrentConversationReadRef.current = markCurrentConversationRead;

  useEffect(() => {
    if (!visible || currentMarkReadMarker === null) {
      clearMarkReadRetry(markReadRetryStateRef.current);
      return;
    }
    if (
      markReadRetryStateRef.current.marker !== null &&
      markReadRetryStateRef.current.marker !== currentMarkReadMarker
    ) {
      clearMarkReadRetry(markReadRetryStateRef.current);
    }
  }, [currentMarkReadMarker, visible]);

  useEffect(() => {
    return () => clearMarkReadRetry(markReadRetryStateRef.current);
  }, []);

  // Mark conversation as read when opened and whenever visible hydration or
  // realtime receipt advances the newest message.
  useEffect(() => {
    if (!visible) return;
    markCurrentConversationRead();
  }, [markCurrentConversationRead, visible]);

  // Register side-effect handlers that don't mutate the message cache
  // (cache updates are handled by useMessageCacheUpdater).
  useEffect(() => {
    const offs = [
      kiloChatClient.onTyping((ctx, data) => {
        handleTypingEvent(ctx, data);
      }),
      kiloChatClient.onTypingStop((ctx, data) => {
        clearTypingForMember(ctx, data.memberId);
      }),
    ];
    return () => offs.forEach(off => off());
  }, [kiloChatClient, handleTypingEvent, clearTypingForMember, conversationId]);

  // Refetch messages on WebSocket reconnect (events may have been missed)
  useEffect(() => {
    return eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'messages', conversationId] });
      if (visible) {
        markCurrentConversationRead();
      }
    });
  }, [conversationId, eventService, markCurrentConversationRead, queryClient, visible]);

  // Auto-scroll whenever content height changes (new messages, streaming
  // updates, image loads). A ResizeObserver on the inner content fires only
  // on actual height deltas, so emoji-picker toggles and reaction-pill
  // updates that don't change layout no longer trigger a scroll.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const wasFetchingNextPage = wasFetchingNextPageRef.current;
    wasFetchingNextPageRef.current = isFetchingNextPage;

    if (!wasFetchingNextPage || isFetchingNextPage) {
      return;
    }

    const snapshot = pendingPrependScrollAnchorRef.current;
    pendingPrependScrollAnchorRef.current = null;
    if (!snapshot) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      applyPrependScrollAnchor(el, snapshot);
    });

    return () => cancelAnimationFrame(frameId);
  }, [isFetchingNextPage]);

  // Track scroll position to detect user scrolling away from bottom
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;

    // Load more on scroll to top
    if (el.scrollTop < 50 && hasNextPage && !isFetchingNextPage) {
      pendingPrependScrollAnchorRef.current = capturePrependScrollAnchor(el);
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

  const handleSend = useCallback(
    async (text: string, inReplyToMessageId?: string): Promise<boolean> => {
      autoScrollRef.current = true;
      setShowScrollButton(false);
      try {
        await sendMessage.mutateAsync({
          conversationId,
          content: [{ type: 'text', text }],
          inReplyToMessageId,
          clientId: ulid(),
        });
        return true;
      } catch (err) {
        toast.error(formatKiloChatError(err, 'Failed to send message'));
        return false;
      }
    },
    [sendMessage.mutateAsync, conversationId]
  );

  const handleEdit = useCallback(
    async (messageId: string, content: ContentBlock[]): Promise<boolean> => {
      try {
        await editMessage.mutateAsync({
          messageId,
          conversationId,
          content: toEditableContent(content),
          timestamp: Date.now(),
        });
        return true;
      } catch (err) {
        if (err instanceof KiloChatApiError && err.status === 409) {
          toast.error('Message was edited by someone else — please try again');
          return false;
        }
        toast.error(formatKiloChatError(err, 'Failed to edit message'));
        return false;
      }
    },
    [editMessage.mutateAsync, conversationId]
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
          onError: err => toast.error(formatKiloChatError(err, 'Failed to delete message')),
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
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to add reaction')) }
      );
    },
    [addReaction.mutate]
  );

  const handleRemoveReaction = useCallback(
    (messageId: string, emoji: string) => {
      removeReaction.mutate(
        { messageId, emoji },
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to remove reaction')) }
      );
    },
    [removeReaction.mutate]
  );

  const handleExecuteAction = useCallback(
    (messageId: string, groupId: string, value: ExecApprovalDecision) => {
      const nextPendingAction = { messageId, groupId };
      if (!tryStartPendingAction(pendingActionRef, nextPendingAction)) {
        return;
      }
      setPendingAction(pendingActionRef.current);
      executeAction.mutate(
        { messageId, groupId, value },
        {
          onError: err => toast.error(formatKiloChatError(err, 'Failed to execute action')),
          onSettled: () => {
            clearPendingAction(pendingActionRef, nextPendingAction);
            setPendingAction(pendingActionRef.current);
          },
        }
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
          { sandboxId, conversationId, title: trimmed },
          { onError: err => toast.error(formatKiloChatError(err, 'Failed to rename conversation')) }
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
        { sandboxId, conversationId, title: trimmed },
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to rename conversation')) }
      );
    }
    setIsRenamingTitle(false);
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        {isRenamingTitle ? (
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="text-sm font-medium bg-transparent outline-none min-w-0 flex-1 mr-2 border-b border-current/20"
            value={renameText}
            onChange={e => setRenameText(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            maxLength={CONVERSATION_TITLE_MAX_CHARS}
          />
        ) : (
          <button
            type="button"
            className="text-sm font-medium bg-transparent outline-none min-w-0 flex-1 mr-2 text-left cursor-pointer hover:opacity-70 transition-opacity border-b border-transparent"
            onClick={handleTitleClick}
            title="Click to rename"
          >
            {title}
          </button>
        )}
        <div className="flex items-center gap-3">
          {ctxUsage && (
            <ContextUsageRing
              contextTokens={ctxUsage.contextTokens}
              contextWindow={ctxUsage.contextWindow}
            />
          )}
          <BotStatus
            instanceStatus={instanceStatus}
            presence={presence}
            model={ctxUsage?.model ?? null}
          />
        </div>
      </div>

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="flex h-full flex-col overflow-y-auto py-4"
          onScroll={handleScroll}
        >
          <div ref={contentRef} className="flex flex-1 flex-col">
            {isFetchingNextPage && (
              <div className="text-muted-foreground py-2 text-center text-xs">
                Loading older messages...
              </div>
            )}
            {messages.length === 0 && !isFetchingNextPage && (
              <div className="flex flex-1 flex-col items-center justify-center px-6">
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
                isOwn={currentUserId !== null && msg.senderId === currentUserId}
                replyToMessage={
                  msg.inReplyToMessageId
                    ? (messageMap.get(msg.inReplyToMessageId) ?? msg.replyTo)
                    : null
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
                pendingActionGroupId={pendingActionGroupIdForMessage(pendingAction, msg.id)}
                currentUserId={currentUserId}
              />
            ))}
          </div>
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="bg-muted hover:bg-accent border-border absolute bottom-0 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full border shadow-md cursor-pointer transition-colors"
            aria-label="Scroll to latest message"
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
        canSend={canSend}
        disabledReason={sendDisabledReason}
      />
    </div>
  );
}
