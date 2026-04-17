'use client';

import { useState, useCallback, createContext, useContext, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { toast } from 'sonner';
import { InstanceSwitcher } from './InstanceSwitcher';
import { ConversationList } from './ConversationList';
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
  botName: string;
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
  children: React.ReactNode;
};

export function KiloChatLayout({
  getToken,
  currentUserId,
  instances,
  instanceStatus,
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

  const params = useParams<{ conversationId?: string }>();
  const [leavingConversationId, setLeavingConversationId] = useState<string | null>(null);
  const { data, isLoading } = useConversations(getToken);
  const createConversation = useCreateConversation(getToken);
  const renameConversation = useRenameConversation(getToken);
  const leaveConversation = useLeaveConversation(getToken);

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

  const botName = instances.find(i => i.sandboxId === selectedSandboxId)?.label || 'KiloClaw';

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
      value={{ getToken, currentUserId, instanceStatus, leavingConversationId, botName }}
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
