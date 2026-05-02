'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Send } from 'lucide-react';
import type { Message } from '@kilocode/kilo-chat';
import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';
import { ReplyPreview } from './ReplyPreview';

type MessageInputProps = {
  onSend: (text: string, inReplyToMessageId?: string) => Promise<boolean>;
  onTyping: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
  assistantName?: string;
  currentUserId: string | null;
  canSend?: boolean;
  disabledReason?: string | null;
};

// Hide the counter until the user is at 80% capacity; below that it's noise.
const COUNTER_SHOW_AT = Math.floor(MESSAGE_TEXT_MAX_CHARS * 0.8);

export function canSubmitMessageInput(
  currentUserId: string | null,
  canSend: boolean,
  overLimit: boolean,
  text: string
): boolean {
  return currentUserId !== null && canSend && !overLimit && text.trim().length > 0;
}

type MessageInputSubmissionState = {
  text: string;
  replyingTo: Message | null;
};

function sameReplyTarget(left: Message | null, right: Message | null): boolean {
  return (left?.id ?? null) === (right?.id ?? null);
}

export function nextMessageInputStateAfterSend(
  currentState: MessageInputSubmissionState,
  submittedState: MessageInputSubmissionState,
  sendSucceeded: boolean
): MessageInputSubmissionState {
  if (!sendSucceeded) return currentState;
  return {
    text: currentState.text === submittedState.text ? '' : currentState.text,
    replyingTo: sameReplyTarget(currentState.replyingTo, submittedState.replyingTo)
      ? null
      : currentState.replyingTo,
  };
}

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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestStateRef = useRef<MessageInputSubmissionState>({ text: '', replyingTo: null });

  useEffect(() => {
    if (replyingTo) textareaRef.current?.focus();
  }, [replyingTo]);

  useLayoutEffect(() => {
    latestStateRef.current = { text, replyingTo };
  }, [text, replyingTo]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [text]);

  const overLimit = text.length > MESSAGE_TEXT_MAX_CHARS;
  const showCounter = text.length >= COUNTER_SHOW_AT;
  const inputEnabled = currentUserId !== null && canSend;
  const effectiveDisabledReason =
    currentUserId === null ? 'Loading user...' : (disabledReason ?? 'Sending is disabled');

  async function handleSubmit() {
    if (isSubmitting) return;
    if (!canSubmitMessageInput(currentUserId, canSend, overLimit, text)) return;
    const trimmed = text.trim();
    const submittedState = { text, replyingTo };
    setIsSubmitting(true);
    try {
      const sendSucceeded = await onSend(trimmed, replyingTo?.id);
      const currentState = latestStateRef.current;
      const nextState = nextMessageInputStateAfterSend(currentState, submittedState, sendSucceeded);
      latestStateRef.current = nextState;
      setText(nextState.text);
      if (currentState.replyingTo !== null && nextState.replyingTo === null) onCancelReply();
    } finally {
      setIsSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const placeholder = inputEnabled ? 'Type a message...' : effectiveDisabledReason;

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
            latestStateRef.current = { ...latestStateRef.current, text: e.target.value };
            setText(e.target.value);
            onTyping();
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          autoFocus
          disabled={!inputEnabled}
        />
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || !canSubmitMessageInput(currentUserId, canSend, overLimit, text)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg p-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          title={inputEnabled ? 'Send' : effectiveDisabledReason}
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
