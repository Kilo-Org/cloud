'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { formatKiloChatError } from '@kilocode/kilo-chat';
import { ConversationList } from './ConversationList';
import { KiloChatContext, type KiloChatContextValue } from './kiloChatContext';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { usePresenceSubscription } from '@/hooks/usePresenceSubscription';
import { useEventServiceClient } from '@/contexts/EventServiceContext';
import {
  useConversations,
  useCreateConversation,
  useRenameConversation,
  useLeaveConversation,
  conversationsKey,
  filterConversationPages,
  type ConversationListInfiniteData,
} from '../hooks/useConversations';
import { registerKiloChatLayoutEventCacheHandlers } from './kiloChatLayoutCache';

// ── Layout component ────────────────────────────────────────────────
type KiloChatLayoutProps = {
  currentUserId: string | null;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  instanceStatus: string | null;
  assistantName: string | null;
  children: React.ReactNode;
};

export function KiloChatLayout({
  currentUserId,
  sandboxId,
  basePath,
  noInstanceRedirect,
  isInstanceLoading,
  instanceStatus,
  assistantName,
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
    return registerKiloChatLayoutEventCacheHandlers({
      currentUserId,
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: conversationsQueryKey,
    });
  }, [currentUserId, eventService, kiloChatClient, queryClient, conversationsQueryKey]);

  const createConversation = useCreateConversation(kiloChatClient);
  const renameConversation = useRenameConversation(kiloChatClient);
  const leaveConversation = useLeaveConversation(kiloChatClient);

  const handleRename = useCallback(
    (conversationId: string, title: string) => {
      renameConversation.mutate(
        { conversationId, title },
        { onError: err => toast.error(formatKiloChatError(err, 'Failed to rename conversation')) }
      );
    },
    [renameConversation.mutate]
  );

  const handleLeave = useCallback(
    (conversationId: string) => {
      // Mark as leaving so child queries disable themselves immediately
      setLeavingConversationId(conversationId);
      // Optimistically remove the row before the router.push fires. When the
      // user leaves the *active* conversation, router navigation concurrent
      // with the mutation's onSuccess invalidateQueries left the row stale
      // in the sidebar until a full page reload. Patching the cache up-front
      // mirrors what onConversationLeft does for other members.
      const previous = queryClient.getQueriesData<ConversationListInfiniteData>({
        queryKey: conversationsQueryKey,
      });
      queryClient.setQueriesData<ConversationListInfiniteData>(
        { queryKey: conversationsQueryKey },
        old => filterConversationPages(old, c => c.conversationId !== conversationId)
      );
      if (params?.conversationId === conversationId) {
        router.push(basePath);
      }
      leaveConversation.mutate(conversationId, {
        onSettled: () => setLeavingConversationId(null),
        onError: err => {
          // Restore the row on failure so the user can retry
          for (const [key, data] of previous) {
            queryClient.setQueryData(key, data);
          }
          toast.error(formatKiloChatError(err, 'Failed to leave conversation'));
        },
      });
    },
    [
      leaveConversation.mutate,
      params?.conversationId,
      queryClient,
      conversationsQueryKey,
      router,
      basePath,
    ]
  );

  const handleNewConversation = useCallback(() => {
    if (!sandboxId) return;
    createConversation.mutate(
      { sandboxId },
      {
        onSuccess: res => {
          router.push(`${basePath}/${res.conversationId}`);
        },
        onError: err => toast.error(formatKiloChatError(err, 'Failed to create conversation')),
      }
    );
  }, [sandboxId, basePath, createConversation.mutate, router]);

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
      eventService,
      kiloChatClient,
    ]
  );

  return (
    <KiloChatContext.Provider value={contextValue}>
      <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
        {/* Conversation sidebar */}
        <div className="border-border flex w-64 shrink-0 flex-col overflow-hidden border-r">
          <ConversationList
            conversations={data?.conversations ?? []}
            isLoading={isLoading}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
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
