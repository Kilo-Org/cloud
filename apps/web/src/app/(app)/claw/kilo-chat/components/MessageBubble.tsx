'use client';

import { useState } from 'react';
import { Pencil, Trash2, Reply } from 'lucide-react';
import type { Message, ContentBlock } from '@kilocode/kilo-chat';
import { ulidToTimestamp, contentBlocksToText } from '@kilocode/kilo-chat';
import { useKiloChatContext } from './KiloChatLayout';

type MessageBubbleProps = {
  message: Message;
  isOwn: boolean;
  replyToMessage?: Message | null;
  pendingDeleteId: string | null;
  onEdit: (messageId: string, content: ContentBlock[], version: number) => void;
  onDelete: (messageId: string) => void;
  onConfirmDelete: (messageId: string) => void;
  onCancelDelete: () => void;
  onReply: (message: Message) => void;
};

export function MessageBubble({
  message,
  isOwn,
  replyToMessage,
  pendingDeleteId,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onReply,
}: MessageBubbleProps) {
  const { botName } = useKiloChatContext();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showActions, setShowActions] = useState(false);

  if (message.deleted) {
    return (
      <div className="px-4 py-1">
        <p className="text-muted-foreground text-sm italic">[message deleted]</p>
      </div>
    );
  }

  const textContent = contentBlocksToText(message.content);
  const isBot = message.senderId.startsWith('bot:');

  function handleStartEdit() {
    setEditText(textContent);
    setIsEditing(true);
  }

  function handleSaveEdit() {
    if (!editText.trim()) return;
    onEdit(message.id, [{ type: 'text', text: editText.trim() }], message.version);
    setIsEditing(false);
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setEditText('');
  }

  const isOptimistic = message.id.startsWith('optimistic-');
  const timestamp = isOptimistic ? new Date() : new Date(ulidToTimestamp(message.id));
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const actionButtons = showActions && !isEditing && pendingDeleteId !== message.id && (
    <div
      className={`bg-background border-border absolute top-0 z-10 flex items-center gap-0.5 rounded border p-0.5 shadow-sm ${
        isOwn ? 'right-full mr-1' : 'left-full ml-1'
      }`}
    >
      {isOwn && (
        <>
          <button
            onClick={handleStartEdit}
            className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete(message.id)}
            className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <button
        onClick={() => onReply(message)}
        className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
        title="Reply"
      >
        <Reply className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  return (
    <div
      className={`group flex px-4 py-1 ${isOwn ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className={`flex max-w-[75%] flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {isBot && !isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">{botName}</span>
        )}

        {replyToMessage && (
          <div className="text-muted-foreground mb-1 flex items-center gap-1 px-1 text-xs">
            <Reply className="h-3 w-3" />
            <span>
              {(() => {
                const preview = contentBlocksToText(replyToMessage.content);
                return preview.length > 60 ? `${preview.slice(0, 60)}...` : preview;
              })()}
            </span>
          </div>
        )}

        <div className="relative">
          {actionButtons}
          <div
            className={`rounded-2xl px-3 py-2 ${
              isOwn ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
            }`}
          >
            {isEditing ? (
              <div>
                <textarea
                  className="border-input bg-background text-foreground w-full rounded border p-2 text-sm"
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  onKeyDown={e => {
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
                    className="text-primary hover:underline cursor-pointer"
                  >
                    Save
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="text-muted-foreground hover:underline cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap">{textContent}</p>
            )}

            <div
              className={`mt-1 flex items-center gap-1 text-[10px] ${
                isOwn
                  ? 'text-primary-foreground/70 justify-end'
                  : 'text-muted-foreground justify-end'
              }`}
            >
              {message.updatedAt && <span>(edited)</span>}
              <span>{timeStr}</span>
            </div>
          </div>
        </div>

        {pendingDeleteId === message.id && (
          <div className="bg-background border-border mt-1 flex items-center gap-1.5 rounded border px-2 py-1 text-xs shadow-sm">
            <span>Delete?</span>
            <button
              onClick={() => onConfirmDelete(message.id)}
              className="text-destructive font-medium hover:underline cursor-pointer"
            >
              Yes
            </button>
            <button
              onClick={onCancelDelete}
              className="text-muted-foreground hover:underline cursor-pointer"
            >
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
