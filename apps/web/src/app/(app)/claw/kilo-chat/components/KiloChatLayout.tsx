'use client';

import { useState, useCallback, createContext, useContext, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import { formatKiloChatError } from '@kilocode/kilo-chat';
import type { BotPresence } from './BotStatus';
import { ConversationList } from './ConversationList';
import { useEventService, useInstanceContext } from '../hooks/useEventService';
import {
  useConversations,
  useCreateConversation,
  useRenameConversation,
  useLeaveConversation,
  updateConversationPages,
  filterConversationPages,
  type ConversationListInfiniteData,
} from '../hooks/useConversations';

// ── Context for child pages ─────────────────────────────────────────
export type BotContextUsage = {
  contextTokens: number;
  contextWindow: number;
  updatedAt: number;
};

type KiloChatContextValue = {
  getToken: () => Promise<string>;
  currentUserId: string;
  instanceStatus: string | null;
  leavingConversationId: string | null;
  assistantName: string | null;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
  botPresence: (sandboxId: string) => BotPresence | undefined;
  botContext: (conversationId: string) => BotContextUsage | undefined;
};

const KiloChatContext = createContext<KiloChatContextValue | null>(null);

export function useKiloChatContext() {
  const ctx = useContext(KiloChatContext);
  if (!ctx) throw new Error('useKiloChatContext must be used within KiloChatLayout');
  return ctx;
}

// ── Layout component ────────────────────────────────────────────────
type KiloChatLayoutProps = {
  getToken: () => Promise<string>;
  currentUserId: string;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  instanceStatus: string | null;
  assistantName: string | null;
  children: React.ReactNode;
};

export function KiloChatLayout({
  getToken,
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

  const { eventService, kiloChatClient } = useEventService(getToken);
  useInstanceContext(eventService, sandboxId);

  // Bot presence + per-conversation context usage, driven by `bot.status` events.
  // Stored as immutable Maps so the context value only changes when data changes;
  // BotStatus owns its own staleness ticker, so no parent-level interval is needed.
  const [presenceMap, setPresenceMap] = useState<Map<string, BotPresence>>(() => new Map());
  const [contextMap, setContextMap] = useState<Map<string, BotContextUsage>>(() => new Map());

  useEffect(() => {
    const off = kiloChatClient.onBotStatus((_ctx, e) => {
      setPresenceMap(prev => {
        const existing = prev.get(e.sandboxId);
        const model = e.model ?? null;
        if (
          existing &&
          existing.online === e.online &&
          existing.lastAt === e.at &&
          existing.model === model
        ) {
          return prev;
        }
        const next = new Map(prev);
        next.set(e.sandboxId, { online: e.online, lastAt: e.at, model });
        return next;
      });

      if (
        e.conversationId &&
        typeof e.contextTokens === 'number' &&
        typeof e.contextWindow === 'number' &&
        e.contextWindow > 0
      ) {
        const conversationId = e.conversationId;
        const contextTokens = e.contextTokens;
        const contextWindow = e.contextWindow;
        setContextMap(prev => {
          const existing = prev.get(conversationId);
          if (
            existing &&
            existing.contextTokens === contextTokens &&
            existing.contextWindow === contextWindow &&
            existing.updatedAt === e.at
          ) {
            return prev;
          }
          const next = new Map(prev);
          next.set(conversationId, { contextTokens, contextWindow, updatedAt: e.at });
          return next;
        });
      }
    });
    return off;
  }, [kiloChatClient]);

  const botPresence = useCallback((sandboxId: string) => presenceMap.get(sandboxId), [presenceMap]);
  const botContext = useCallback(
    (conversationId: string) => contextMap.get(conversationId),
    [contextMap]
  );

  const queryClient = useQueryClient();
  const params = useParams<{ conversationId?: string }>();
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useConversations(
    kiloChatClient,
    sandboxId
  );

  // Update conversation list cache in-place when activity events arrive.
  // For cursor pagination, events targeting conversations outside page 1 are
  // ignored by an in-place patch, so the list appears stale. Invalidate the
  // cache so the affected conversation either appears at the top (new/active)
  // or re-sorts correctly once refetched.
  useEffect(() => {
    const queryKey = ['kilo-chat', 'conversations'];

    function isOnFirstPage(conversationId: string): boolean {
      const entries = queryClient.getQueriesData<ConversationListInfiniteData>({ queryKey });
      for (const [, data] of entries) {
        const firstPage = data?.pages[0];
        if (firstPage?.conversations.some(c => c.conversationId === conversationId)) {
          return true;
        }
      }
      return false;
    }

    const offs = [
      kiloChatClient.onConversationCreated((_ctx, e) => {
        if (isOnFirstPage(e.conversationId)) return;
        void queryClient.invalidateQueries({ queryKey });
      }),
      kiloChatClient.onConversationRenamed((_ctx, e) => {
        queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
          updateConversationPages(old, c =>
            c.conversationId === e.conversationId ? { ...c, title: e.title } : c
          )
        );
        // Also update the conversation detail cache if it's loaded
        void queryClient.invalidateQueries({
          queryKey: ['kilo-chat', 'conversation', e.conversationId],
        });
      }),
      kiloChatClient.onConversationLeft((_ctx, e) => {
        queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
          filterConversationPages(old, c => c.conversationId !== e.conversationId)
        );
      }),
      kiloChatClient.onConversationRead((_ctx, e) => {
        // `.read` is broadcast to every human in the conversation with the
        // `memberId` of whose read-marker moved. Only the actual reader
        // should see their own sidebar row's `lastReadAt` advance — without
        // this filter, Alice marking read would also move Bob's `lastReadAt`.
        if (e.memberId !== currentUserId) return;
        queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
          updateConversationPages(old, c =>
            c.conversationId === e.conversationId ? { ...c, lastReadAt: e.lastReadAt } : c
          )
        );
      }),
      kiloChatClient.onConversationActivity((_ctx, e) => {
        if (isOnFirstPage(e.conversationId)) {
          queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
            updateConversationPages(old, c =>
              c.conversationId === e.conversationId ? { ...c, lastActivityAt: e.lastActivityAt } : c
            )
          );
          return;
        }
        void queryClient.invalidateQueries({ queryKey });
      }),
    ];
    return () => offs.forEach(off => off());
  }, [kiloChatClient, queryClient]);

  // Refetch conversations on WebSocket reconnect (events may have been missed)
  useEffect(() => {
    return eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    });
  }, [eventService, queryClient]);

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
      const queryKey = ['kilo-chat', 'conversations'];
      // Optimistically remove the row before the router.push fires. When the
      // user leaves the *active* conversation, router navigation concurrent
      // with the mutation's onSuccess invalidateQueries left the row stale
      // in the sidebar until a full page reload. Patching the cache up-front
      // mirrors what onConversationLeft does for other members.
      const previous = queryClient.getQueriesData<ConversationListInfiniteData>({ queryKey });
      queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
        filterConversationPages(old, c => c.conversationId !== conversationId)
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
    [leaveConversation.mutate, params?.conversationId, queryClient, router, basePath]
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
      getToken,
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
      botPresence,
      botContext,
    }),
    [
      getToken,
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
      botPresence,
      botContext,
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
