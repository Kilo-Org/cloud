'use client';

import { X } from 'lucide-react';
import type { Message } from '../types';

type ReplyPreviewProps = {
  message: Message;
  onCancel: () => void;
};

export function ReplyPreview({ message, onCancel }: ReplyPreviewProps) {
  const text = message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .slice(0, 100);

  return (
    <div className="border-border bg-muted/50 flex items-center gap-2 border-t px-4 py-2">
      <div className="bg-primary h-full w-0.5 rounded" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs font-medium">
          Replying to{' '}
          {message.senderId.startsWith('bot:') ? 'KiloClaw' : 'yourself'}
        </p>
        <p className="text-muted-foreground truncate text-xs">{text}</p>
      </div>
      <button
        onClick={onCancel}
        className="hover:bg-muted rounded p-1"
        title="Cancel reply"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
