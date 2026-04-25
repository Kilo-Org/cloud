'use client';

import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import type { Message } from '@kilocode/kilo-chat';
import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
import { ReplyPreview } from './ReplyPreview';

type MessageInputProps = {
  onSend: (text: string, inReplyToMessageId?: string) => void;
  onTyping: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
  assistantName?: string;
  currentUserId: string;
  canSend?: boolean;
  disabledReason?: string | null;
};

// Hide the counter until the user is at 80% capacity; below that it's noise.
const COUNTER_SHOW_AT = Math.floor(MESSAGE_TEXT_MAX_CHARS * 0.8);

export function MessageInput({
  onSend,
  onTyping,
  replyingTo,
  onCancelReply,
  assistantName,
  currentUserId,
  canSend = true,
  disabledReason,
}: MessageInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [text]);

  const overLimit = text.length > MESSAGE_TEXT_MAX_CHARS;
  const showCounter = text.length >= COUNTER_SHOW_AT;

  function handleSubmit() {
    if (!canSend) return;
    if (overLimit) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed, replyingTo?.id);
    setText('');
    onCancelReply();
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const placeholder = canSend ? 'Type a message...' : (disabledReason ?? 'Sending is disabled');

  return (
    <div className="border-border border-t">
      {replyingTo && (
        <ReplyPreview
          message={replyingTo}
          onCancel={onCancelReply}
          assistantName={assistantName}
          currentUserId={currentUserId}
        />
      )}
      <div className="flex items-end gap-2 p-4">
        <textarea
          ref={textareaRef}
          className="border-input bg-background max-h-[200px] flex-1 resize-none overflow-y-auto rounded-lg border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          placeholder={placeholder}
          value={text}
          onChange={e => {
            setText(e.target.value);
            onTyping();
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
          disabled={!canSend}
        />
        <button
          onClick={handleSubmit}
          disabled={!canSend || overLimit || !text.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg p-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          title={canSend ? 'Send' : (disabledReason ?? 'Sending is disabled')}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      {/* Space is reserved unconditionally so the counter appearing/disappearing
          doesn't jank the textarea. */}
      <div
        className={`px-4 pb-2 text-right text-xs ${
          overLimit ? 'text-destructive' : 'text-muted-foreground'
        } ${showCounter ? '' : 'invisible'}`}
        aria-live="polite"
      >
        {text.length.toLocaleString('en-US')} / {MESSAGE_TEXT_MAX_CHARS.toLocaleString('en-US')}
      </div>
    </div>
  );
}
