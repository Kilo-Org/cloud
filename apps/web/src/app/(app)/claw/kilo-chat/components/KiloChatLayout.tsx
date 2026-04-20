'use client';

import { useState, useCallback, createContext, useContext, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient, ConversationListResponse } from '@kilocode/kilo-chat';
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
type KiloChatContextValue = {
  getToken: () => Promise<string>;
  currentUserId: string;
  instanceStatus: string | null;
  leavingConversationId: string | null;
  assistantName: string | null;
  sandboxId: string | null;
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
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

  const queryClient = useQueryClient();
  const params = useParams<{ conversationId?: string }>();
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const { data, isLoading } = useConversations(kiloChatClient, selectedSandboxId);

  // Update conversation list cache in-place when activity events arrive
  useEffect(() => {
    return kiloChatClient.onConversationActivity((_ctx, e) => {
      queryClient.setQueriesData<ConversationListResponse>(
        { queryKey: ['kilo-chat', 'conversations'] },
        old => {
          if (!old) return old;
          return {
            ...old,
            conversations: old.conversations.map(c =>
              c.conversationId === e.conversationId ? { ...c, lastActivityAt: e.lastActivityAt } : c
            ),
          };
        }
      );
    });
  }, [kiloChatClient, queryClient]);
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
    [renameConversation]
  );

  const handleLeave = useCallback(
    (conversationId: string) => {
      // Mark as leaving so child queries disable themselves immediately
      setLeavingConversationId(conversationId);
      if (params?.conversationId === conversationId) {
        router.push('/claw/kilo-chat');
      }
      leaveConversation.mutate(conversationId, {
        onError: () => {
          setLeavingConversationId(null);
          toast.error('Failed to leave conversation');
        },
      });
    },
    [leaveConversation, params?.conversationId, router]
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
  }, [selectedSandboxId, createConversation, router]);

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
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </KiloChatContext.Provider>
  );
}
