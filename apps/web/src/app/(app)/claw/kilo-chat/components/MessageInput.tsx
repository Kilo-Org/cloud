'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Plus, Send } from 'lucide-react';
import {
  MESSAGE_TEXT_MAX_CHARS,
  ATTACHMENT_MAX_BYTES,
  formatFileSize,
  type InputContentBlock,
  type Message,
} from '@kilocode/kilo-chat';
import { toast } from 'sonner';
import { selectIsUploading, selectHasFailed, useAttachmentQueue } from '@kilocode/kilo-chat-hooks';

import { ReplyPreview } from './ReplyPreview';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';
import { useKiloChatContext } from './kiloChatContext';
import { webPerformUpload } from '../lib/web-perform-upload';

type MessageInputProps = {
  conversationId: string;
  onSend: (blocks: InputContentBlock[], inReplyToMessageId?: string) => Promise<boolean>;
  onTyping: () => void;
  replyingTo: Message | null;
  onCancelReply: () => void;
  assistantName?: string;
  currentUserId: string | null;
  canSend?: boolean;
  disabledReason?: string | null;
  hasAttachmentsCapability: boolean;
};

const COUNTER_SHOW_AT = Math.floor(MESSAGE_TEXT_MAX_CHARS * 0.8);
const MAX_ATTACHMENTS = 10;

type CanSubmitInput = {
  currentUserId: string | null;
  canSend: boolean;
  overLimit: boolean;
  text: string;
  readyAttachmentCount: number;
  isUploading: boolean;
  hasFailedAttachments: boolean;
};

export function canSubmitMessageInput(input: CanSubmitInput): boolean {
  if (input.currentUserId === null) return false;
  if (!input.canSend) return false;
  if (input.overLimit) return false;
  if (input.isUploading || input.hasFailedAttachments) return false;
  const hasText = input.text.trim().length > 0;
  const hasAttachments = input.readyAttachmentCount > 0;
  return hasText || hasAttachments;
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
  conversationId,
  onSend,
  onTyping,
  replyingTo,
  onCancelReply,
  assistantName,
  currentUserId,
  canSend = true,
  disabledReason,
  hasAttachmentsCapability,
}: MessageInputProps) {
  const { kiloChatClient } = useKiloChatContext();
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // dragenter/dragleave bubble from inner elements, so a plain boolean
  // flickers as the cursor moves between the textarea, plus button, etc.
  // Counter pattern: increment on enter, decrement on leave, hide when zero.
  const dragDepthRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestStateRef = useRef<MessageInputSubmissionState>({ text: '', replyingTo: null });

  const queue = useAttachmentQueue(kiloChatClient, conversationId, {
    performUpload: webPerformUpload,
    maxBytes: ATTACHMENT_MAX_BYTES,
    onSizeRejected: input =>
      toast.error(
        `${input.filename} exceeds the ${formatFileSize(ATTACHMENT_MAX_BYTES)} attachment limit`
      ),
  });

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
  const showPlus = hasAttachmentsCapability && inputEnabled;

  const isUploading = selectIsUploading(queue.rows);
  const hasFailedAttachments = selectHasFailed(queue.rows);
  const readyAttachmentCount = queue.readyBlocks.length;

  let effectiveDisabledReason: string;
  if (currentUserId === null) effectiveDisabledReason = 'Loading user...';
  else if (hasFailedAttachments)
    effectiveDisabledReason = 'Resolve failed attachments before sending';
  else if (isUploading) effectiveDisabledReason = 'Waiting for attachment upload to finish';
  else effectiveDisabledReason = disabledReason ?? 'Sending is disabled';

  const canSubmit = canSubmitMessageInput({
    currentUserId,
    canSend,
    overLimit,
    text,
    readyAttachmentCount,
    isUploading,
    hasFailedAttachments,
  });

  function addFilesFromList(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const remaining = MAX_ATTACHMENTS - queue.rows.length;
    if (remaining <= 0) {
      toast.error(`Max ${MAX_ATTACHMENTS} attachments per message`);
      return;
    }
    const toAdd = list.slice(0, remaining);
    if (toAdd.length < list.length) {
      const noun =
        remaining === 1 ? 'Only the first file was' : `Only the first ${remaining} files were`;
      toast.error(`${noun} added (max ${MAX_ATTACHMENTS} per message)`);
    }
    for (const file of toAdd) {
      const filename = file.name || 'attachment';
      const mimeType = file.type || 'application/octet-stream';
      queue.addFile({ blob: file, filename, mimeType });
    }
  }

  async function handleSubmit() {
    if (isSubmitting) return;
    if (!canSubmit) return;
    const trimmed = text.trim();
    const blocks: InputContentBlock[] = [];
    if (trimmed.length > 0) blocks.push({ type: 'text', text: trimmed });
    for (const block of queue.readyBlocks) blocks.push(block);
    if (blocks.length === 0) return;
    const submittedAttachmentTempIds = queue.rows
      .filter(row => row.status === 'ready' && typeof row.attachmentId === 'string')
      .map(row => row.tempId);
    const submittedState = { text, replyingTo };
    setIsSubmitting(true);
    try {
      const sendSucceeded = await onSend(blocks, replyingTo?.id);
      const currentState = latestStateRef.current;
      const nextState = nextMessageInputStateAfterSend(currentState, submittedState, sendSucceeded);
      latestStateRef.current = nextState;
      setText(nextState.text);
      if (sendSucceeded) {
        queue.clearFiles(submittedAttachmentTempIds);
      }
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

  function handlePickClick() {
    fileInputRef.current?.click();
  }

  function handleFilesPicked(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFilesFromList(e.target.files);
    e.target.value = '';
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!showPlus) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!showPlus) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
  }

  function handleDragLeave() {
    if (dragDepthRef.current === 0) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    if (!showPlus) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) addFilesFromList(e.dataTransfer.files);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!showPlus) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length === 0) return;
    e.preventDefault();
    addFilesFromList(pastedFiles);
  }

  const placeholder = inputEnabled ? 'Type a message...' : effectiveDisabledReason;

  return (
    <div
      className="border-border relative border-t"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="bg-primary/10 border-primary pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed">
          <span className="text-primary text-sm font-medium">Drop files to attach</span>
        </div>
      )}
      {replyingTo && (
        <ReplyPreview
          message={replyingTo}
          onCancel={onCancelReply}
          assistantName={assistantName}
          currentUserId={currentUserId}
        />
      )}
      <AttachmentPreviewStrip
        rows={queue.rows}
        getBlob={queue.getBlob}
        onRemove={tempId => queue.removeFile(tempId)}
        onRetry={tempId => queue.retryFile(tempId)}
      />
      <div className="flex items-end gap-2 p-4">
        {showPlus && (
          <>
            <button
              onClick={handlePickClick}
              className="hover:bg-muted rounded-lg p-2 cursor-pointer transition-colors"
              title="Attach files"
              aria-label="Attach files"
              type="button"
            >
              <Plus className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFilesPicked}
              className="hidden"
            />
          </>
        )}
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
          onPaste={handlePaste}
          rows={1}
          autoFocus
          disabled={!inputEnabled}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || !canSubmit}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg p-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
          title={inputEnabled ? 'Send' : effectiveDisabledReason}
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
      {/* Space is reserved unconditionally (invisible vs hidden) so the
        counter appearing near the limit doesn't shove the input upward. */}
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
