'use client';

import { useState, useRef, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Pencil, Trash2, Reply, X, Check, AlertCircle, Smile, Copy } from 'lucide-react';
import { EmojiQuickPick } from './EmojiQuickPick';
import { EmojiPicker } from './EmojiPicker';
import { ReactionPills } from './ReactionPills';
import type {
  Message,
  ContentBlock,
  ExecApprovalDecision,
  ReplyToMessageSnapshot,
} from '@kilocode/kilo-chat';
import {
  buildMessageActionAvailability,
  MESSAGE_TEXT_MAX_CHARS,
  ulidToTimestamp,
  contentBlocksToText,
} from '@kilocode/kilo-chat';
import { useKiloChatContext } from './kiloChatContext';
import { toast } from 'sonner';
import { isMessageEditOverLimit, submitMessageEdit } from './message-edit-state';

const EDIT_COUNTER_SHOW_AT = Math.floor(MESSAGE_TEXT_MAX_CHARS * 0.8);

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
  replyToMessage?: Message | ReplyToMessageSnapshot | null;
  pendingDeleteId: string | null;
  onEdit: (messageId: string, content: ContentBlock[]) => Promise<boolean>;
  onDelete: (messageId: string) => void;
  onConfirmDelete: (messageId: string) => void;
  onCancelDelete: () => void;
  onReply: (message: Message) => void;
  onAddReaction: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;
  onExecuteAction: (messageId: string, groupId: string, value: ExecApprovalDecision) => void;
  pendingActionGroupId: string | null;
  currentUserId: string | null;
};

function getReplyPreviewText(replyToMessage: Message | ReplyToMessageSnapshot): string {
  const preview =
    'previewText' in replyToMessage
      ? (replyToMessage.previewText ?? 'Message')
      : contentBlocksToText(replyToMessage.content);
  return preview.length > 60 ? `${preview.slice(0, 60)}...` : preview;
}

export const MessageBubble = memo(function MessageBubble({
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
  onExecuteAction,
  pendingActionGroupId,
  currentUserId,
}: MessageBubbleProps) {
  const { assistantName } = useKiloChatContext();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showQuickPick, setShowQuickPick] = useState(false);
  const [showFullPicker, setShowFullPicker] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const isBot = message.senderId.startsWith('bot:');
  const isOptimistic = message.id.startsWith('pending-');
  const timestamp = isOptimistic ? new Date() : new Date(ulidToTimestamp(message.id));
  const timeStr = timestamp.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  const textContent = message.deleted ? '' : contentBlocksToText(message.content);
  const editOverLimit = isMessageEditOverLimit(editText);
  const showEditCounter = editText.length >= EDIT_COUNTER_SHOW_AT || editOverLimit;
  const baseActionAvailability = buildMessageActionAvailability(message, isOwn);
  const actionAvailability =
    currentUserId === null
      ? {
          canReact: false,
          canEdit: false,
          canDelete: false,
          canReply: false,
          canExecuteAction: false,
        }
      : baseActionAvailability;

  const myReactions = new Set(
    currentUserId === null
      ? []
      : message.reactions.filter(r => r.memberIds.includes(currentUserId)).map(r => r.emoji)
  );

  function handleStartEdit() {
    if (!actionAvailability.canEdit) return;
    setEditText(textContent);
    setIsEditing(true);
  }

  const canSaveEdit =
    actionAvailability.canEdit && !isSavingEdit && editText.trim().length > 0 && !editOverLimit;

  async function handleSaveEdit() {
    if (!canSaveEdit) return;
    setIsSavingEdit(true);
    try {
      await submitMessageEdit({
        messageId: message.id,
        editText,
        originalText: textContent,
        onEdit,
        closeEditor: () => {
          setIsEditing(false);
          setEditText('');
        },
      });
    } finally {
      setIsSavingEdit(false);
    }
  }

  function handleCancelEdit() {
    setIsEditing(false);
    setEditText('');
    setIsSavingEdit(false);
  }

  function handleQuickPickSelect(emoji: string) {
    setShowQuickPick(false);
    if (!actionAvailability.canReact) return;
    if (myReactions.has(emoji)) {
      onRemoveReaction(message.id, emoji);
    } else {
      onAddReaction(message.id, emoji);
    }
  }

  function handleFullPickerSelect(emoji: string) {
    setShowFullPicker(false);
    setShowQuickPick(false);
    if (!actionAvailability.canReact) return;
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
      {actionAvailability.canReact && (
        <button
          onClick={() => setShowQuickPick(prev => !prev)}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="React"
        >
          <Smile className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(textContent).then(
            () => toast.success('Copied to clipboard'),
            () => toast.error('Failed to copy')
          );
        }}
        className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
        title="Copy"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      {actionAvailability.canEdit && (
        <button
          onClick={handleStartEdit}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {actionAvailability.canDelete && (
        <button
          onClick={() => onDelete(message.id)}
          className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      {actionAvailability.canReply && (
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
      className={`group flex [content-visibility:auto] [contain-intrinsic-size:0_120px] px-4 py-1 ${isOwn ? 'justify-end' : 'justify-start'}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => {
        if (!showFullPicker) {
          setShowActions(false);
          setShowQuickPick(false);
        }
      }}
    >
      <div className={`flex max-w-[75%] min-w-0 flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
        {isBot && !isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">
            {assistantName ?? 'KiloClaw'}
          </span>
        )}

        {replyToMessage && (
          <div className="text-muted-foreground mb-1 flex items-center gap-1 px-1 text-xs">
            <Reply className="h-3 w-3" />
            {replyToMessage.deleted ? (
              <span className="italic opacity-70">original message deleted</span>
            ) : (
              <span>{getReplyPreviewText(replyToMessage)}</span>
            )}
          </div>
        )}

        <div className="relative min-w-0 max-w-full">
          {actionButtons}
          {showQuickPick && actionAvailability.canReact && (
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
          {showFullPicker && actionAvailability.canReact && (
            <EmojiPicker
              onSelect={handleFullPickerSelect}
              onClose={() => setShowFullPicker(false)}
              anchorRef={bubbleRef}
            />
          )}
          <div
            ref={bubbleRef}
            className={`overflow-hidden rounded-2xl px-3 py-2 ${
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
                      if (canSaveEdit) void handleSaveEdit();
                    }
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  autoFocus
                />
                <div
                  className={`mt-1 text-right text-[11px] ${
                    editOverLimit ? 'text-destructive' : 'opacity-70'
                  } ${showEditCounter ? '' : 'invisible'}`}
                  aria-live="polite"
                >
                  {editText.length.toLocaleString('en-US')} /{' '}
                  {MESSAGE_TEXT_MAX_CHARS.toLocaleString('en-US')}
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <button
                    onClick={() => void handleSaveEdit()}
                    disabled={!canSaveEdit}
                    className="rounded p-0.5 hover:opacity-70 cursor-pointer transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
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
              // prose-invert is unconditional (not dark:prose-invert) because bot
              // bubbles use bg-muted which is dark in the chat panel's dark theme.
              // This is intentional — do not "fix" to dark:prose-invert.
              <div
                className={`prose prose-sm max-w-none break-words [&_pre]:overflow-x-auto [&_code]:break-all [&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 ${isOwn ? '' : 'prose-invert'}`}
              >
                <MemoizedMarkdown content={textContent} />
              </div>
            )}

            {!message.deleted &&
              message.content
                .filter(b => b.type === 'actions')
                .map(block => {
                  if (block.type !== 'actions') return null;
                  const actionsBlock = block;

                  if (actionsBlock.resolved) {
                    const resolvedAction = actionsBlock.actions.find(
                      a => a.value === actionsBlock.resolved?.value
                    );
                    const label = resolvedAction?.label ?? actionsBlock.resolved.value;
                    const isApproved = actionsBlock.resolved.value !== 'deny';
                    return (
                      <div
                        key={actionsBlock.groupId}
                        className="mt-2 flex items-center gap-1.5 text-xs opacity-70"
                      >
                        {isApproved ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                        <span>{label}</span>
                      </div>
                    );
                  }

                  return (
                    <div key={actionsBlock.groupId} className="mt-2 flex items-center gap-2">
                      {actionsBlock.actions.map(action => (
                        <button
                          key={action.value}
                          disabled={
                            pendingActionGroupId === actionsBlock.groupId ||
                            !actionAvailability.canExecuteAction
                          }
                          onClick={() =>
                            actionAvailability.canExecuteAction &&
                            onExecuteAction(message.id, actionsBlock.groupId, action.value)
                          }
                          className={`rounded-md px-3 py-1 text-xs font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                            action.style === 'primary'
                              ? 'bg-green-600 hover:bg-green-700 text-white'
                              : action.style === 'danger'
                                ? 'bg-red-600 hover:bg-red-700 text-white'
                                : 'bg-gray-200 hover:bg-gray-300 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200'
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  );
                })}

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
          {actionAvailability.canReact && (
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
});
