import { History, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { JSX } from 'react';
import { getStoredConversationTitle, isStoredConversationOpen } from './agent-conversation-storage';
import type { StoredAgentConversation } from './agent-conversation-storage';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';

const formatHistoryUpdatedAt = (updatedAt: string): string => {
  const date = new Date(updatedAt);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleString([], {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  });
};

export const ConversationHistoryButton = ({
  activeConversationId,
  conversations,
  conversationStore,
  onDeleteConversation,
  onOpenConversation,
}: {
  activeConversationId: string;
  conversations: StoredAgentConversation[];
  conversationStore: StoredAgentConversationStore;
  onDeleteConversation: (conversationId: string) => void;
  onOpenConversation: (conversationId: string) => void;
}): JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative">
      <button
        aria-expanded={isOpen}
        aria-label="History"
        className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
        onClick={() => {
          setIsOpen(current => !current);
        }}
        title="History"
        type="button"
      >
        <History aria-hidden="true" className="size-4" />
      </button>

      {isOpen ? (
        <div
          aria-label="Conversation history"
          className="agent-conversation-scrollbar absolute right-0 top-10 z-20 grid max-h-96 w-72 gap-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 shadow-xl shadow-black/30"
        >
          {conversations.map(conversation => {
            const title = getStoredConversationTitle(conversation);
            const isConversationOpen = isStoredConversationOpen(conversationStore, conversation.id);

            return (
              <div
                className={
                  conversation.id === activeConversationId
                    ? 'grid gap-2 rounded-sm bg-zinc-900 p-2'
                    : 'grid gap-2 rounded-sm p-2 hover:bg-zinc-900'
                }
                key={conversation.id}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium text-zinc-100" title={title}>
                      {title}
                    </p>
                    {isConversationOpen ? (
                      <span className="rounded-sm border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium uppercase text-zinc-400">
                        Open
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {formatHistoryUpdatedAt(conversation.updatedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    aria-label={`Open ${title}`}
                    className="h-7 rounded-md border border-zinc-700 px-2 text-xs font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-[#EDFF00]/50"
                    onClick={() => {
                      onOpenConversation(conversation.id);
                      setIsOpen(false);
                    }}
                    type="button"
                  >
                    Open
                  </button>
                  <button
                    aria-label={`Delete ${title}`}
                    className="flex size-7 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 transition hover:border-red-500/70 hover:bg-red-950/30 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400/50"
                    onClick={() => {
                      onDeleteConversation(conversation.id);
                    }}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
