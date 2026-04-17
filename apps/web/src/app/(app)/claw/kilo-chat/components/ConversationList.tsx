'use client';

import { Plus } from 'lucide-react';
import { useParams } from 'next/navigation';
import type { ConversationListItem } from '@kilocode/kilo-chat';
import { ConversationItem } from './ConversationItem';

type ConversationListProps = {
  conversations: ConversationListItem[];
  isLoading: boolean;
  onNewConversation: () => void;
  onRename: (id: string, title: string) => void;
  onLeave: (id: string) => void;
};

export function ConversationList({
  conversations,
  isLoading,
  onNewConversation,
  onRename,
  onLeave,
}: ConversationListProps) {
  const params = useParams<{ conversationId?: string }>();
  const activeId = params?.conversationId;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-muted-foreground text-xs font-medium uppercase">Conversations</span>
        <button
          onClick={onNewConversation}
          className="hover:bg-muted rounded p-1"
          title="New conversation"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {isLoading ? (
          <div className="text-muted-foreground px-3 py-4 text-center text-xs">Loading...</div>
        ) : conversations.length === 0 ? (
          <div className="text-muted-foreground px-3 py-4 text-center text-xs">
            No conversations yet
          </div>
        ) : (
          conversations.map(conv => (
            <ConversationItem
              key={conv.conversationId}
              conversation={conv}
              isActive={conv.conversationId === activeId}
              onRename={onRename}
              onLeave={onLeave}
            />
          ))
        )}
      </div>
    </div>
  );
}
