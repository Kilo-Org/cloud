'use client';

import { useState, useCallback, createContext, useContext } from 'react';
import { useRouter } from 'next/navigation';
import { InstanceSwitcher } from './InstanceSwitcher';
import { ConversationList } from './ConversationList';
import { useConversations, useCreateConversation } from '../hooks/useConversations';

// ── Context for child pages ─────────────────────────────────────────
type KiloChatContextValue = {
  getToken: () => Promise<string>;
  currentUserId: string;
  token: string | null;
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
  token: string | null;
  instances: Array<{ sandboxId: string; label: string }>;
  children: React.ReactNode;
};

export function KiloChatLayout({
  getToken,
  currentUserId,
  token,
  instances,
  children,
}: KiloChatLayoutProps) {
  const router = useRouter();
  const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(
    instances[0]?.sandboxId ?? null
  );

  const { data, isLoading } = useConversations(getToken, selectedSandboxId);
  const createConversation = useCreateConversation(getToken);

  const handleNewConversation = useCallback(() => {
    if (!selectedSandboxId) return;
    createConversation.mutate(
      { sandboxId: selectedSandboxId },
      {
        onSuccess: res => {
          router.push(`/claw/kilo-chat/${res.conversationId}`);
        },
      }
    );
  }, [selectedSandboxId, createConversation, router]);

  return (
    <KiloChatContext.Provider value={{ getToken, currentUserId, token }}>
      <div className="flex h-[calc(100vh-3.5rem)]">
        {/* Conversation sidebar */}
        <div className="border-border w-64 shrink-0 border-r">
          <InstanceSwitcher
            instances={instances}
            selectedId={selectedSandboxId}
            onSelect={setSelectedSandboxId}
          />
          <ConversationList
            conversations={data?.conversations ?? []}
            isLoading={isLoading}
            onNewConversation={handleNewConversation}
          />
        </div>

        {/* Main content */}
        <div className="flex-1">{children}</div>
      </div>
    </KiloChatContext.Provider>
  );
}
