import { useVirtualizer } from '@tanstack/react-virtual';
import { History, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX } from 'react';
import { getStoredConversationTitle, isStoredConversationOpen } from './agent-conversation-storage';
import type { StoredAgentConversation } from './agent-conversation-storage';
import type { StoredAgentConversationStore } from '@/src/shared/agent-conversation-tabs';

const historyPageSize = 100;

const getHistorySpacerStyle = (height: number): CSSProperties => ({
  height: `${height}px`,
});

const getHistoryRowStyle = (start: number): CSSProperties => ({
  transform: `translateY(${start}px)`,
});

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
  const [visibleCount, setVisibleCount] = useState(historyPageSize);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const visibleConversations = useMemo(
    () => conversations.slice(0, Math.min(visibleCount, conversations.length)),
    [conversations, visibleCount]
  );
  const hasMore = visibleConversations.length < conversations.length;
  const virtualizer = useVirtualizer({
    count: visibleConversations.length + (hasMore ? 1 : 0),
    estimateSize: () => 92,
    getScrollElement: () => historyRef.current,
    overscan: 8,
  });
  const openHistory = (): void => {
    setVisibleCount(historyPageSize);
    setIsOpen(true);
  };

  return (
    <div className="relative">
      <button
        aria-expanded={isOpen}
        aria-label="History"
        className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
            return;
          }

          openHistory();
        }}
        title="History"
        type="button"
      >
        <History aria-hidden="true" className="size-4" />
      </button>

      {isOpen ? (
        <div
          aria-label="Conversation history"
          aria-modal="true"
          className="agent-conversation-scrollbar fixed inset-0 z-30 flex flex-col overflow-y-auto bg-zinc-950"
          ref={historyRef}
          role="dialog"
        >
          <div className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-100">History</p>
              <p className="text-xs text-zinc-500">
                {conversations.length === 1
                  ? '1 conversation'
                  : `${conversations.length} conversations`}
              </p>
            </div>
            <button
              aria-label="Close history"
              className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
              onClick={() => {
                setIsOpen(false);
              }}
              type="button"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
          <div className="px-3 py-3">
            {conversations.length === 0 ? (
              <p className="px-1 py-8 text-center text-sm text-zinc-500">No conversations yet</p>
            ) : (
              <div
                className="relative w-full"
                style={getHistorySpacerStyle(virtualizer.getTotalSize())}
              >
                {virtualizer.getVirtualItems().map(virtualItem => {
                  if (virtualItem.index === visibleConversations.length) {
                    return (
                      <div
                        className="absolute left-0 top-0 w-full px-1 py-3"
                        key="load-more"
                        style={getHistoryRowStyle(virtualItem.start)}
                      >
                        <button
                          className="h-9 w-full rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-[#EDFF00] focus:ring-offset-2 focus:ring-offset-zinc-950"
                          onClick={() => {
                            setVisibleCount(count =>
                              Math.min(conversations.length, count + historyPageSize)
                            );
                          }}
                          type="button"
                        >
                          Show 100 more conversations
                        </button>
                        <p className="mt-2 text-center text-xs text-zinc-500">
                          Showing {visibleConversations.length} of {conversations.length}
                        </p>
                      </div>
                    );
                  }

                  const conversation = visibleConversations[virtualItem.index];

                  if (conversation === undefined) {
                    return null;
                  }

                  const title = getStoredConversationTitle(conversation);
                  const isConversationOpen = isStoredConversationOpen(
                    conversationStore,
                    conversation.id
                  );

                  return (
                    <div
                      className="absolute left-0 top-0 w-full px-1 pb-2"
                      data-history-index={virtualItem.index}
                      key={conversation.id}
                      ref={virtualizer.measureElement}
                      style={getHistoryRowStyle(virtualItem.start)}
                    >
                      <div
                        className={
                          conversation.id === activeConversationId
                            ? 'grid gap-2 rounded-md border border-[#EDFF00]/40 bg-zinc-900 p-2'
                            : 'grid gap-2 rounded-md border border-transparent p-2 hover:border-zinc-800 hover:bg-zinc-900'
                        }
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {hasMore ? (
            <p className="border-t border-zinc-900 px-4 py-2 text-center text-xs text-zinc-500">
              Showing {visibleConversations.length} of {conversations.length}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
