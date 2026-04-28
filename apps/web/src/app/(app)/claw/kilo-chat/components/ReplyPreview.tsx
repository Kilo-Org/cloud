'use client';

import { X } from 'lucide-react';
import type { Message } from '@kilocode/kilo-chat';
import { contentBlocksToText } from '@kilocode/kilo-chat';

type ReplyPreviewProps = {
  message: Message;
  onCancel: () => void;
  assistantName?: string;
  currentUserId: string;
};

export function ReplyPreview({
  message,
  onCancel,
  assistantName,
  currentUserId,
}: ReplyPreviewProps) {
  const text = message.deleted
    ? 'original message deleted'
    : contentBlocksToText(message.content).slice(0, 100);

  return (
    <div className="border-border bg-muted/50 flex items-center gap-2 border-t px-4 py-2">
      <div className="bg-primary h-full w-0.5 rounded" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs font-medium">
          Replying to{' '}
          {message.senderId.startsWith('bot:')
            ? (assistantName ?? 'KiloClaw')
            : message.senderId === currentUserId
              ? 'yourself'
              : 'someone'}
        </p>
        <p
          className={`text-muted-foreground truncate text-xs ${message.deleted ? 'italic opacity-70' : ''}`}
        >
          {text}
        </p>
      </div>
      <button
        onClick={onCancel}
        className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
        title="Cancel reply"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
