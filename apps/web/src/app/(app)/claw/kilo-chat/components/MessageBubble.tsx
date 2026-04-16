'use client';

import { useState } from 'react';
import { Pencil, Trash2, Reply } from 'lucide-react';
import type { Message, ContentBlock } from '../types';

type MessageBubbleProps = {
  message: Message;
  isOwn: boolean;
  replyToMessage?: Message | null;
  onEdit: (messageId: string, content: ContentBlock[], version: number) => void;
  onDelete: (messageId: string) => void;
  onReply: (message: Message) => void;
};

export function MessageBubble({
  message,
  isOwn,
  replyToMessage,
  onEdit,
  onDelete,
  onReply,
}: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showActions, setShowActions] = useState(false);

  if (message.deleted) {
    return (
      <div className="px-4 py-1">
        <p className="text-muted-foreground text-sm italic">
          [message deleted]
        </p>
      </div>
    );
  }

  const textContent = message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  function handleStartEdit() {
    setEditText(textContent);
    setIsEditing(true);
  }

  function handleSaveEdit() {
    if (!editText.trim()) return;
    onEdit(
      message.id,
      [{ type: 'text', text: editText.trim() }],
      message.version,
    );
    setIsEditing(false);
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setEditText('');
  }

  const timestamp = new Date(
    // ULID encodes timestamp in first 10 chars
    parseInt(message.id.slice(0, 10), 36),
  );
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div
      className="group relative px-4 py-1 hover:bg-muted/50"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      {replyToMessage && (
        <div className="text-muted-foreground mb-1 flex items-center gap-1 text-xs">
          <Reply className="h-3 w-3" />
          <span>
            Replying to{' '}
            {replyToMessage.content
              .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text',
              )
              .map((b) => b.text)
              .join(' ')
              .slice(0, 60)}
            {(replyToMessage.content
              .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text',
              )
              .map((b) => b.text)
              .join(' ').length ?? 0) > 60
              ? '...'
              : ''}
          </span>
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">
              {isOwn
                ? 'You'
                : message.senderId.startsWith('bot:')
                  ? 'KiloClaw'
                  : message.senderId}
            </span>
            <span className="text-muted-foreground text-xs">{timeStr}</span>
            {message.updatedAt && (
              <span className="text-muted-foreground text-xs">(edited)</span>
            )}
          </div>

          {isEditing ? (
            <div className="mt-1">
              <textarea
                className="border-input bg-background w-full rounded border p-2 text-sm"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSaveEdit();
                  }
                  if (e.key === 'Escape') handleCancelEdit();
                }}
                autoFocus
                rows={2}
              />
              <div className="mt-1 flex gap-2 text-xs">
                <button
                  onClick={handleSaveEdit}
                  className="text-primary hover:underline"
                >
                  Save
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="text-muted-foreground hover:underline"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm whitespace-pre-wrap">{textContent}</p>
          )}
        </div>

        {showActions && isOwn && !isEditing && (
          <div className="bg-background border-border flex items-center gap-0.5 rounded border p-0.5 shadow-sm">
            <button
              onClick={handleStartEdit}
              className="hover:bg-muted rounded p-1"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onDelete(message.id)}
              className="hover:bg-muted rounded p-1"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onReply(message)}
              className="hover:bg-muted rounded p-1"
              title="Reply"
            >
              <Reply className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
