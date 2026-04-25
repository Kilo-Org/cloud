'use client';

import { useState, useCallback, createContext, useContext, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type { BotPresence } from './BotStatus';
import { InstanceSwitcher } from './InstanceSwitcher';
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
  instances: Array<{ sandboxId: string; label: string }>;
  instanceStatus: string | null;
  assistantName: string | null;
  children: React.ReactNode;
};

export function KiloChatLayout({
  getToken,
  currentUserId,
  instances,
  instanceStatus,
  assistantName,
  children,
}: KiloChatLayoutProps) {
  const router = useRouter();
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    instances[0]?.sandboxId ?? null
  );

  useEffect(() => {
    if (instances.length === 0) return;
    const stillValid = selectedSandboxId && instances.some(i => i.sandboxId === selectedSandboxId);
    if (!stillValid) {
      setSelectedSandboxId(instances[0].sandboxId);
    }
  }, [instances, selectedSandboxId]);

  const { eventService, kiloChatClient } = useEventService(getToken);
  useInstanceContext(eventService, selectedSandboxId);

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
    selectedSandboxId
  );

  // Update conversation list cache in-place when activity events arrive
  useEffect(() => {
    const queryKey = ['kilo-chat', 'conversations'];
    const offs = [
      kiloChatClient.onConversationCreated(() => {
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
        queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
          updateConversationPages(old, c =>
            c.conversationId === e.conversationId ? { ...c, lastReadAt: e.lastReadAt } : c
          )
        );
      }),
      kiloChatClient.onConversationActivity((_ctx, e) => {
        queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
          updateConversationPages(old, c =>
            c.conversationId === e.conversationId ? { ...c, lastActivityAt: e.lastActivityAt } : c
          )
        );
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
        { onError: () => toast.error('Failed to rename conversation') }
      );
    },
    [renameConversation.mutate]
  );

  const handleLeave = useCallback(
    (conversationId: string) => {
      // Mark as leaving so child queries disable themselves immediately
      setLeavingConversationId(conversationId);
      if (params?.conversationId === conversationId) {
        router.push('/claw/kilo-chat');
      }
      leaveConversation.mutate(conversationId, {
        onSettled: () => setLeavingConversationId(null),
        onError: () => {
          toast.error('Failed to leave conversation');
        },
      });
    },
    [leaveConversation.mutate, params?.conversationId, router]
  );

  const handleNewConversation = useCallback(() => {
    if (!selectedSandboxId) return;
    createConversation.mutate(
      { sandboxId: selectedSandboxId },
      {
        onSuccess: res => {
          router.push(`/claw/kilo-chat/${res.conversationId}`);
        },
        onError: () => toast.error('Failed to create conversation'),
      }
    );
  }, [selectedSandboxId, createConversation.mutate, router]);

  const contextValue = useMemo<KiloChatContextValue>(
    () => ({
      getToken,
      currentUserId,
      instanceStatus,
      leavingConversationId,
      assistantName,
      sandboxId: selectedSandboxId,
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
      selectedSandboxId,
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
          <InstanceSwitcher
            instances={instances}
            selectedId={selectedSandboxId}
            onSelect={setSelectedSandboxId}
          />
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
