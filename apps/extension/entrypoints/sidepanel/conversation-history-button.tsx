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
    estimateSize: () => 105,
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
        className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
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
          className="agent-conversation-scrollbar fixed inset-0 z-30 flex flex-col overflow-y-auto bg-surface-background"
          ref={historyRef}
          role="dialog"
        >
          <div className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">History</p>
              <p className="type-label text-foreground-muted">
                {conversations.length === 1
                  ? '1 conversation'
                  : `${conversations.length} conversations`}
              </p>
            </div>
            <button
              aria-label="Close history"
              className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
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
              <p className="type-body px-1 py-8 text-center text-foreground-muted">
                No conversations yet
              </p>
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
                          className="type-label h-9 w-full rounded-md border border-border bg-surface-overlay px-3 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
                          onClick={() => {
                            setVisibleCount(count =>
                              Math.min(conversations.length, count + historyPageSize)
                            );
                          }}
                          type="button"
                        >
                          Show 100 more conversations
                        </button>
                        <p className="type-label mt-2 text-center text-foreground-muted">
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
                            ? 'grid gap-2 rounded-md border border-border-strong bg-surface-selected p-2'
                            : 'grid gap-2 rounded-md border border-transparent p-2 hover:border-border hover:bg-surface-hover'
                        }
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <p
                              className="type-body truncate font-medium text-foreground"
                              title={title}
                            >
                              {title}
                            </p>
                            {isConversationOpen ? (
                              <span className="type-eyebrow rounded-sm border border-border px-1.5 py-0.5 text-foreground-muted">
                                Open
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                            {formatHistoryUpdatedAt(conversation.updatedAt)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            aria-label={`Open ${title}`}
                            className="type-label h-8 rounded-md border border-border bg-surface-overlay px-2 text-foreground-on-secondary transition hover:bg-surface-hover outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
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
                            className="flex size-8 items-center justify-center rounded-md border border-border bg-surface-overlay text-foreground-on-secondary transition hover:border-status-red-500/50 hover:bg-status-red-500/10 hover:text-status-red-300 outline-none focus-visible:ring-2 focus-visible:ring-brand-primary-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-background"
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
            <p className="type-label border-t border-border px-4 py-2 text-center text-foreground-muted">
              Showing {visibleConversations.length} of {conversations.length}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
