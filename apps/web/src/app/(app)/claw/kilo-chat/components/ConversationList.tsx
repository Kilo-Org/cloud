'use client';

import { useCallback, useMemo } from 'react';
import { AlertTriangle, Loader2, Plus, RefreshCw } from 'lucide-react';
import { useParams } from 'next/navigation';
import type { ConversationListItem } from '@kilocode/kilo-chat';
import { ConversationItem } from './ConversationItem';

function getConversationTimestamp(conv: ConversationListItem): number {
  return conv.lastActivityAt ?? conv.joinedAt;
}

function groupConversations(
  conversations: ConversationListItem[]
): Array<{ label: string; items: ConversationListItem[] }> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  const groups: Record<string, ConversationListItem[]> = {
    Today: [],
    Yesterday: [],
    'This Week': [],
    Older: [],
  };

  for (const conv of conversations) {
    const ts = getConversationTimestamp(conv);
    if (ts >= todayStart) {
      groups['Today'].push(conv);
    } else if (ts >= yesterdayStart) {
      groups['Yesterday'].push(conv);
    } else if (ts >= weekStart) {
      groups['This Week'].push(conv);
    } else {
      groups['Older'].push(conv);
    }
  }

  return (['Today', 'Yesterday', 'This Week', 'Older'] as const)
    .filter(label => groups[label].length > 0)
    .map(label => ({ label, items: groups[label] }));
}

type ConversationListProps = {
  conversations: ConversationListItem[];
  hasConversationHistoryError?: boolean;
  hasConversationPaginationError?: boolean;
  isLoading: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isCreatingConversation?: boolean;
  newConversationError?: string | null;
  onLoadMore?: () => void;
  onRetryConversationHistory?: () => void;
  onNewConversation: () => void;
  onRename: (id: string, title: string) => void;
  onLeave: (id: string) => void;
};

type ConversationListUiState = {
  buttonLabel: string;
  buttonTitle: string;
  disabled: boolean;
  emptyText: string;
  historyErrorText: string | null;
  showError: boolean;
};

export function buildConversationListUiState({
  hasConversationHistoryError = false,
  isCreatingConversation,
  newConversationError,
}: {
  hasConversationHistoryError?: boolean;
  isCreatingConversation: boolean;
  newConversationError: string | null;
}): ConversationListUiState {
  if (isCreatingConversation) {
    return {
      buttonLabel: 'Creating conversation',
      buttonTitle: 'Creating conversation',
      disabled: true,
      emptyText: 'Creating conversation...',
      historyErrorText: null,
      showError: false,
    };
  }

  if (hasConversationHistoryError) {
    return {
      buttonLabel: 'New conversation',
      buttonTitle: 'New conversation',
      disabled: false,
      emptyText: 'Failed to load conversations',
      historyErrorText: 'Failed to load conversations',
      showError: newConversationError !== null,
    };
  }

  return {
    buttonLabel: 'New conversation',
    buttonTitle: 'New conversation',
    disabled: false,
    emptyText:
      newConversationError === null
        ? 'No conversations yet'
        : 'No conversations yet. Create one to start chatting.',
    historyErrorText: null,
    showError: newConversationError !== null,
  };
}

export function ConversationList({
  conversations,
  hasConversationHistoryError = false,
  hasConversationPaginationError = false,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  isCreatingConversation = false,
  newConversationError = null,
  onLoadMore,
  onRetryConversationHistory,
  onNewConversation,
  onRename,
  onLeave,
}: ConversationListProps) {
  const params = useParams<{ conversationId?: string }>();
  const activeId = params?.conversationId;
  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const conversationListUi = buildConversationListUiState({
    hasConversationHistoryError,
    isCreatingConversation,
    newConversationError,
  });

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!hasNextPage || isFetchingNextPage || hasConversationPaginationError || !onLoadMore)
        return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
        onLoadMore();
      }
    },
    [hasNextPage, isFetchingNextPage, hasConversationPaginationError, onLoadMore]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-muted-foreground text-xs font-medium uppercase">Conversations</span>
        <button
          type="button"
          disabled={conversationListUi.disabled}
          onClick={onNewConversation}
          aria-busy={isCreatingConversation}
          aria-label={conversationListUi.buttonLabel}
          title={conversationListUi.buttonTitle}
          className="hover:bg-muted focus-visible:ring-ring rounded p-1 cursor-pointer transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCreatingConversation ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </button>
      </div>

      {conversationListUi.showError && (
        <div className="text-destructive mx-3 mb-2 flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{newConversationError}</span>
        </div>
      )}

      {conversationListUi.historyErrorText !== null && conversations.length > 0 && (
        <div
          role="alert"
          className="text-destructive mx-3 mb-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{conversationListUi.historyErrorText}</span>
          {onRetryConversationHistory && (
            <button
              type="button"
              onClick={onRetryConversationHistory}
              className="border-input text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-md border px-1.5 py-1 font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          )}
        </div>
      )}

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2" onScroll={handleScroll}>
        {isLoading ? (
          <div className="text-muted-foreground px-3 py-4 text-center text-xs">Loading...</div>
        ) : conversations.length === 0 ? (
          <div
            role={conversationListUi.historyErrorText === null ? undefined : 'alert'}
            className={
              conversationListUi.historyErrorText === null
                ? 'text-muted-foreground flex flex-col items-center gap-2 px-3 py-4 text-center text-xs'
                : 'text-destructive mx-1 my-2 flex flex-col items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-3 text-center text-xs'
            }
          >
            {conversationListUi.historyErrorText !== null && (
              <AlertTriangle className="h-3.5 w-3.5" />
            )}
            <span>{conversationListUi.emptyText}</span>
            {conversationListUi.historyErrorText !== null && onRetryConversationHistory && (
              <button
                type="button"
                onClick={onRetryConversationHistory}
                className="border-input text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {groups.map(group => (
              <div key={group.label}>
                <div className="text-muted-foreground px-3 pt-3 pb-1 text-[11px] font-medium uppercase">
                  {group.label}
                </div>
                {group.items.map(conv => (
                  <ConversationItem
                    key={conv.conversationId}
                    conversation={conv}
                    isActive={conv.conversationId === activeId}
                    onRename={onRename}
                    onLeave={onLeave}
                  />
                ))}
              </div>
            ))}
            {isFetchingNextPage && (
              <div className="text-muted-foreground px-3 py-2 text-center text-xs">Loading...</div>
            )}
            {hasConversationPaginationError && !isFetchingNextPage && (
              <div
                role="alert"
                className="text-destructive mx-1 my-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1">Failed to load more conversations</span>
                {onLoadMore && (
                  <button
                    type="button"
                    onClick={onLoadMore}
                    className="border-input text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-md border px-1.5 py-1 font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
