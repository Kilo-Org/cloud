'use client';

import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import type { Message } from '../types';
import { ReplyPreview } from './ReplyPreview';

type MessageInputProps = {
  onSend: (text: string, inReplyToMessageId?: string) => void;
  onTyping: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
  disabled?: boolean;
};

export function MessageInput({
  onSend,
  onTyping,
  replyingTo,
  onCancelReply,
  disabled,
}: MessageInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  function handleSubmit() {
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

  return (
    <div className="border-border border-t">
      {replyingTo && (
        <ReplyPreview message={replyingTo} onCancel={onCancelReply} />
      )}
      <div className="flex items-end gap-2 p-4">
        <textarea
          ref={textareaRef}
          className="border-input bg-background flex-1 resize-none rounded-lg border px-3 py-2 text-sm"
          placeholder="Type a message..."
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onTyping();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !text.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg p-2 disabled:opacity-50"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
