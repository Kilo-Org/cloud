'use client';

import { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import type { Message } from '@kilocode/kilo-chat';
import { ReplyPreview } from './ReplyPreview';

type MessageInputProps = {
  onSend: (text: string, inReplyToMessageId?: string) => void;
  onTyping: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
  assistantName?: string;
  currentUserId: string;
};

export function MessageInput({
  onSend,
  onTyping,
  replyingTo,
  onCancelReply,
  assistantName,
  currentUserId,
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
          className="border-input bg-background max-h-[200px] flex-1 resize-none overflow-y-auto rounded-lg border px-3 py-2 text-sm"
          placeholder="Type a message..."
          value={text}
          onChange={e => {
            setText(e.target.value);
            onTyping();
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg p-2 disabled:opacity-50 cursor-pointer transition-colors"
          title="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
