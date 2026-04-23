'use client';

import { useState, useCallback, createContext, useContext, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient, ConversationListResponse } from '@kilocode/kilo-chat';
import type { BotPresence } from './BotStatus';
import { InstanceSwitcher } from './InstanceSwitcher';
import { ConversationList } from './ConversationList';
import { useEventService, useInstanceContext } from '../hooks/useEventService';
import {
  useConversations,
  useCreateConversation,
  useRenameConversation,
  useLeaveConversation,
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
  const presenceRef = useRef(new Map<string, BotPresence>());
  const contextRef = useRef(new Map<string, BotContextUsage>());
  const [, forceTick] = useState(0);
  const bump = useCallback(() => forceTick(n => n + 1), []);

  useEffect(() => {
    const off = kiloChatClient.onBotStatus((_ctx, e) => {
      presenceRef.current.set(e.sandboxId, {
        online: e.online,
        lastAt: e.at,
        model: e.model ?? null,
      });
      if (
        e.conversationId &&
        typeof e.contextTokens === 'number' &&
        typeof e.contextWindow === 'number' &&
        e.contextWindow > 0
      ) {
        contextRef.current.set(e.conversationId, {
          contextTokens: e.contextTokens,
          contextWindow: e.contextWindow,
          updatedAt: e.at,
        });
      }
      bump();
    });
    return off;
  }, [kiloChatClient, bump]);

  // Staleness ticker: re-render every 10s so BotStatus re-evaluates elapsed time.
  useEffect(() => {
    const id = setInterval(bump, 10_000);
    return () => clearInterval(id);
  }, [bump]);

  const botPresence = useCallback((sandboxId: string) => presenceRef.current.get(sandboxId), []);
  const botContext = useCallback(
    (conversationId: string) => contextRef.current.get(conversationId),
    []
  );

  const queryClient = useQueryClient();
  const params = useParams<{ conversationId?: string }>();
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const { data, isLoading } = useConversations(kiloChatClient, selectedSandboxId);

  // Update conversation list cache in-place when activity events arrive
  useEffect(() => {
    const offs = [
      kiloChatClient.onConversationCreated(() => {
        void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
      }),
      kiloChatClient.onConversationRenamed((_ctx, e) => {
        queryClient.setQueriesData<ConversationListResponse>(
          { queryKey: ['kilo-chat', 'conversations'] },
          (old: ConversationListResponse | undefined) => {
            if (!old) return old;
            return {
              ...old,
              conversations: old.conversations.map(c =>
                c.conversationId === e.conversationId ? { ...c, conversationTitle: e.title } : c
              ),
            };
          }
        );
        // Also update the conversation detail cache if it's loaded
        void queryClient.invalidateQueries({
          queryKey: ['kilo-chat', 'conversation', e.conversationId],
        });
      }),
      kiloChatClient.onConversationLeft((_ctx, e) => {
        queryClient.setQueriesData<ConversationListResponse>(
          { queryKey: ['kilo-chat', 'conversations'] },
          (old: ConversationListResponse | undefined) => {
            if (!old) return old;
            const filtered = old.conversations.filter(c => c.conversationId !== e.conversationId);
            if (filtered.length === old.conversations.length) return old;
            return { ...old, conversations: filtered, total: old.total - 1 };
          }
        );
      }),
      kiloChatClient.onConversationRead((_ctx, e) => {
        queryClient.setQueriesData<ConversationListResponse>(
          { queryKey: ['kilo-chat', 'conversations'] },
          (old: ConversationListResponse | undefined) => {
            if (!old) return old;
            return {
              ...old,
              conversations: old.conversations.map(c =>
                c.conversationId === e.conversationId ? { ...c, lastReadAt: e.lastReadAt } : c
              ),
            };
          }
        );
      }),
      kiloChatClient.onConversationActivity((_ctx, e) => {
        queryClient.setQueriesData<ConversationListResponse>(
          { queryKey: ['kilo-chat', 'conversations'] },
          (old: ConversationListResponse | undefined) => {
            if (!old) return old;
            return {
              ...old,
              conversations: old.conversations.map(c =>
                c.conversationId === e.conversationId
                  ? { ...c, lastActivityAt: e.lastActivityAt }
                  : c
              ),
            };
          }
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

  return (
    <KiloChatContext.Provider
      value={{
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
      }}
    >
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
