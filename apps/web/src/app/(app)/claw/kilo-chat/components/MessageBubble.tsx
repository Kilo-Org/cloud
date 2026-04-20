'use client';

import { useState, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Trash2, Reply, X, Check, AlertCircle, Smile } from 'lucide-react';
import { EmojiQuickPick } from './EmojiQuickPick';
import { EmojiPicker } from './EmojiPicker';
import { ReactionPills } from './ReactionPills';
import type { Message, ContentBlock } from '@kilocode/kilo-chat';
import { ulidToTimestamp, contentBlocksToText } from '@kilocode/kilo-chat';
import { useKiloChatContext } from './KiloChatLayout';

const MemoizedMarkdown = memo(function MemoizedMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

type MessageBubbleProps = {
  message: Message;
  isOwn: boolean;
  replyToMessage?: Message | null;
  pendingDeleteId: string | null;
  onEdit: (messageId: string, content: ContentBlock[]) => void;
  onDelete: (messageId: string) => void;
  onConfirmDelete: (messageId: string) => void;
  onCancelDelete: () => void;
  onReply: (message: Message) => void;
  onAddReaction: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;
  currentUserId: string;
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
  onAddReaction,
  onRemoveReaction,
  currentUserId,
}: MessageBubbleProps) {
  const { assistantName } = useKiloChatContext();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showActions, setShowActions] = useState(false);
  const [showQuickPick, setShowQuickPick] = useState(false);
  const [showFullPicker, setShowFullPicker] = useState(false);

  const isBot = message.senderId.startsWith('bot:');
  const isOptimistic = message.id.startsWith('pending-');
  const timestamp = isOptimistic ? new Date() : new Date(ulidToTimestamp(message.id));
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const textContent = message.deleted ? '' : contentBlocksToText(message.content);

  const myReactions = new Set(
    message.reactions.filter(r => r.memberIds.includes(currentUserId)).map(r => r.emoji)
  );

  function handleStartEdit() {
    setEditText(textContent);
    setIsEditing(true);
  }

  function handleSaveEdit() {
    if (!editText.trim()) return;
    onEdit(message.id, [{ type: 'text', text: editText.trim() }]);
    setIsEditing(false);
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setEditText('');
  }

  function handleQuickPickSelect(emoji: string) {
    setShowQuickPick(false);
    if (myReactions.has(emoji)) {
      onRemoveReaction(message.id, emoji);
    } else {
      onAddReaction(message.id, emoji);
    }
  }

  function handleFullPickerSelect(emoji: string) {
    setShowFullPicker(false);
    setShowQuickPick(false);
    if (myReactions.has(emoji)) {
      onRemoveReaction(message.id, emoji);
    } else {
      onAddReaction(message.id, emoji);
    }
  }

  const isDeleting = pendingDeleteId === message.id;

  const actionButtons = showActions && !isEditing && !isDeleting && !message.deleted && (
    <div
      className={`bg-background border-border absolute top-0 z-10 flex items-center gap-0.5 rounded border p-0.5 shadow-sm ${
        isOwn ? 'right-full mr-1' : 'left-full ml-1'
      }`}
    >
      <button
        onClick={() => setShowQuickPick(prev => !prev)}
        className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
        title="React"
      >
        <Smile className="h-3.5 w-3.5" />
      </button>
      {isOwn && !message.deliveryFailed && (
        <button
          onClick={handleStartEdit}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {isOwn && (
        <button
          onClick={() => onDelete(message.id)}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      {!message.deliveryFailed && (
        <button
          onClick={() => onReply(message)}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="Reply"
        >
          <Reply className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`group flex px-4 py-1 ${isOwn ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        if (!showFullPicker) {
          setShowActions(false);
          setShowQuickPick(false);
        }
      }}
    >
      <div className={`flex max-w-[75%] flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {isBot && !isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">
            {assistantName ?? 'KiloClaw'}
          </span>
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
          {showQuickPick && (
            <div className={`absolute z-20 ${isOwn ? 'right-full mr-1' : 'left-full ml-1'} top-0`}>
              <EmojiQuickPick
                currentUserReactions={myReactions}
                onSelect={handleQuickPickSelect}
                onOpenFullPicker={() => {
                  setShowQuickPick(false);
                  setShowFullPicker(true);
                }}
              />
            </div>
          )}
          {showFullPicker && (
            <div className={`absolute bottom-full mb-2 z-50 ${isOwn ? 'right-0' : 'left-0'}`}>
              <EmojiPicker
                onSelect={handleFullPickerSelect}
                onClose={() => setShowFullPicker(false)}
              />
            </div>
          )}
          <div
            className={`rounded-2xl px-3 py-2 ${
              isOwn ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
            }`}
          >
            {message.deleted ? (
              <p className="text-sm italic opacity-50">[deleted message]</p>
            ) : isEditing ? (
              <div>
                <textarea
                  className="bg-transparent w-full text-sm outline-none border-b border-current/20 pb-0.5 resize-none"
                  rows={Math.min(editText.split('\n').length, 8)}
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
                />
                <div className="mt-1 flex items-center gap-1">
                  <button
                    onClick={handleSaveEdit}
                    className="rounded p-0.5 hover:opacity-70 cursor-pointer transition-opacity"
                    title="Save (Enter)"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="rounded p-0.5 hover:opacity-70 cursor-pointer transition-opacity opacity-60"
                    title="Cancel (Esc)"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ) : isDeleting ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">Delete this message?</span>
                <button
                  onClick={() => onConfirmDelete(message.id)}
                  className="rounded p-0.5 hover:opacity-70 cursor-pointer transition-opacity"
                  title="Confirm delete"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={onCancelDelete}
                  className="rounded p-0.5 hover:opacity-70 cursor-pointer transition-opacity opacity-60"
                  title="Cancel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div
                className={`prose prose-sm max-w-none break-words [&_pre]:overflow-x-auto [&_code]:break-all [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 ${isOwn ? '' : 'prose-invert'}`}
              >
                <MemoizedMarkdown content={textContent} />
              </div>
            )}

            <div
              className={`mt-1 flex items-center gap-1 text-[10px] ${
                isOwn
                  ? 'text-primary-foreground/70 justify-end'
                  : 'text-muted-foreground justify-end'
              }`}
            >
              {message.deliveryFailed && (
                <span
                  className="text-destructive flex items-center gap-0.5"
                  title="Delivery failed"
                >
                  <AlertCircle className="h-3 w-3" />
                  Not delivered
                </span>
              )}
              {message.clientUpdatedAt && !message.deleted && <span>(edited)</span>}
              <span>{timeStr}</span>
            </div>
          </div>
          {!message.deleted && !message.deliveryFailed && (
            <ReactionPills
              reactions={message.reactions}
              currentUserId={currentUserId}
              isOwn={isOwn}
              onAdd={emoji => onAddReaction(message.id, emoji)}
              onRemove={emoji => onRemoveReaction(message.id, emoji)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
