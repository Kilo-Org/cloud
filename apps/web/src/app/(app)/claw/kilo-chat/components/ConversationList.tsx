'use client';

import { useCallback, useMemo } from 'react';
import { Plus } from 'lucide-react';
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
  isLoading: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  onNewConversation: () => void;
  onRename: (id: string, title: string) => void;
  onLeave: (id: string) => void;
};

export function ConversationList({
  conversations,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onNewConversation,
  onRename,
  onLeave,
}: ConversationListProps) {
  const params = useParams<{ conversationId?: string }>();
  const activeId = params?.conversationId;
  const groups = useMemo(() => groupConversations(conversations), [conversations]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!hasNextPage || isFetchingNextPage || !onLoadMore) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
        onLoadMore();
      }
    },
    [hasNextPage, isFetchingNextPage, onLoadMore]
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-muted-foreground text-xs font-medium uppercase">Conversations</span>
        <button
          type="button"
          onClick={onNewConversation}
          aria-label="New conversation"
          title="New conversation"
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2" onScroll={handleScroll}>
        {isLoading ? (
          <div className="text-muted-foreground px-3 py-4 text-center text-xs">Loading...</div>
        ) : conversations.length === 0 ? (
          <div className="text-muted-foreground px-3 py-4 text-center text-xs">
            No conversations yet
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
          </>
        )}
      </div>
    </div>
  );
}
