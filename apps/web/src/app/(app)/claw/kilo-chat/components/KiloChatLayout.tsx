'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { formatKiloChatError } from '@kilocode/kilo-chat';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';
import { ConversationList } from './ConversationList';
import { KiloChatContext, type KiloChatContextValue } from './kiloChatContext';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { useEventServiceClient } from '@/contexts/EventServiceContext';
import { cn } from '@/lib/utils';
import {
  useConversations,
  useCreateConversation,
  useRenameConversation,
  useLeaveConversation,
  conversationsKey,
  registerConversationListCacheHandlers,
} from '../hooks/useConversations';

// ── Layout component ────────────────────────────────────────────────
type KiloChatLayoutProps = {
  currentUserId: string | null;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  isInstanceError: boolean;
  instanceErrorMessage: string | null;
  onRetryInstanceStatus: () => void;
  instanceStatus: string | null;
  assistantName: string | null;
  className?: string;
  children: React.ReactNode;
};

export function KiloChatLayout({
  currentUserId,
  sandboxId,
  basePath,
  noInstanceRedirect,
  isInstanceLoading,
  isInstanceError,
  instanceErrorMessage,
  onRetryInstanceStatus,
  instanceStatus,
  assistantName,
  className,
  children,
}: KiloChatLayoutProps) {
  const router = useRouter();

  const { eventService, kiloChatClient } = useEventServiceClient();
  usePresenceSubscription(
    sandboxId ? kiloclawInstanceContext(sandboxId) : null,
    Boolean(sandboxId)
  );

  const queryClient = useQueryClient();
  const params = useParams<{ conversationId?: string }>();
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const conversationsQueryKey = useMemo(() => conversationsKey(sandboxId), [sandboxId]);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations(
    kiloChatClient,
    sandboxId
  );

  // Update loaded conversation-list cache rows in-place when instance events arrive.
  // Unknown conversations still invalidate so they can be fetched into the list.
  useEffect(() => {
    return registerConversationListCacheHandlers({
      activeConversationId: params?.conversationId ?? null,
      currentUserId,
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: conversationsQueryKey,
      sandboxId,
    });
  }, [
    currentUserId,
    eventService,
    kiloChatClient,
    params?.conversationId,
    queryClient,
    conversationsQueryKey,
    sandboxId,
  ]);

  const createConversation = useCreateConversation(kiloChatClient);
  const renameConversation = useRenameConversation(kiloChatClient);
  const leaveConversation = useLeaveConversation(kiloChatClient);
  const [newConversationError, setNewConversationError] = useState<string | null>(null);

  const handleRename = useCallback(
    (conversationId: string, title: string) => {
      renameConversation.mutate(
        { sandboxId, conversationId, title },
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to rename conversation')) }
      );
    },
    [sandboxId, renameConversation.mutate]
  );

  const handleLeave = useCallback(
    (conversationId: string) => {
      const isActiveConversation = params?.conversationId === conversationId;
      setLeavingConversationId(conversationId);
      leaveConversation.mutate(
        { sandboxId, conversationId },
        {
          onSettled: () => setLeavingConversationId(null),
          onSuccess: () => {
            if (isActiveConversation) {
              router.push(basePath);
            }
          },
          onError: err => {
            toast.error(formatKiloChatError(err, 'Failed to leave conversation'));
          },
        }
      );
    },
    [sandboxId, leaveConversation.mutate, params?.conversationId, router, basePath]
  );

  const handleNewConversation = useCallback(() => {
    if (!sandboxId || createConversation.isPending) return;
    setNewConversationError(null);
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: res => {
          setNewConversationError(null);
          router.push(`${basePath}/${res.conversationId}`);
        },
        onError: err => {
          const message = formatKiloChatError(
            err,
            "Couldn't create conversation. Check your connection and try again."
          );
          setNewConversationError(message);
          toast.error(message);
        },
      }
    );
  }, [
    sandboxId,
    basePath,
    createConversation.isPending,
    createConversation.mutate,
    router,
    setNewConversationError,
  ]);

  const contextValue = useMemo<KiloChatContextValue>(
    () => ({
      currentUserId,
      instanceStatus,
      leavingConversationId,
      assistantName,
      sandboxId,
      basePath,
      noInstanceRedirect,
      isInstanceLoading,
      isInstanceError,
      instanceErrorMessage,
      onRetryInstanceStatus,
      eventService,
      kiloChatClient,
    }),
    [
      currentUserId,
      instanceStatus,
      leavingConversationId,
      assistantName,
      sandboxId,
      basePath,
      noInstanceRedirect,
      isInstanceLoading,
      isInstanceError,
      instanceErrorMessage,
      onRetryInstanceStatus,
      eventService,
      kiloChatClient,
    ]
  );

  return (
    <KiloChatContext.Provider value={contextValue}>
      <div className={cn('flex min-h-0 overflow-hidden', className ?? 'h-[calc(100dvh-3.5rem)]')}>
        {/* Conversation sidebar */}
        <div className="border-border flex w-64 shrink-0 flex-col overflow-hidden border-r">
          <ConversationList
            conversations={data?.conversations ?? []}
            isLoading={isLoading}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isCreatingConversation={createConversation.isPending}
            newConversationError={newConversationError}
            onLoadMore={() => void fetchNextPage()}
            onNewConversation={handleNewConversation}
            onRename={handleRename}
            onLeave={handleLeave}
          />
        </div>

        {/* Main content */}
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </KiloChatContext.Provider>
  );
}
