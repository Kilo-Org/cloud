'use client';

import Link from 'next/link';
import type { ConversationListItem } from '../types';

type ConversationItemProps = {
  conversation: ConversationListItem;
  isActive: boolean;
};

export function ConversationItem({ conversation, isActive }: ConversationItemProps) {
  const lastMessageTime = conversation.lastMessageId
    ? new Date(parseInt(conversation.lastMessageId.slice(0, 10), 36)).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <Link
      href={`/claw/kilo-chat/${conversation.conversationId}`}
      className={`block rounded-md px-3 py-2 ${
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
      }`}
      prefetch={false}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {conversation.conversationTitle ?? 'Untitled'}
        </p>
        {lastMessageTime && (
          <span className="text-muted-foreground shrink-0 text-xs">{lastMessageTime}</span>
        )}
      </div>
    </Link>
  );
}
