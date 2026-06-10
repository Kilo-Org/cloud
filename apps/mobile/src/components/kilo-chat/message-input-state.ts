import {
  type AttachmentBlock,
  type InputContentBlock,
  MESSAGE_TEXT_MAX_CHARS,
} from '@kilocode/kilo-chat';

type DraftRef = { current: string };

export type MessageInputSubmitControls = {
  clearDraft: () => boolean;
};

type SubmittedMessageDraft = {
  text: string;
  content: InputContentBlock[];
  replyingToMessageId?: string;
};

type MessageInputContentInput = {
  text: string;
  readyAttachmentBlocks?: readonly AttachmentBlock[];
};

export function buildMessageInputContentBlocks({
  text,
  readyAttachmentBlocks = [],
}: MessageInputContentInput): InputContentBlock[] {
  const trimmedText = text.trim();
  const textBlocks: InputContentBlock[] =
    trimmedText.length > 0 ? [{ type: 'text', text: trimmedText }] : [];
  return [...textBlocks, ...readyAttachmentBlocks];
}

export function canSubmitMessageInputContent({
  text,
  readyAttachmentBlocks = [],
  hasUploadingAttachment = false,
  hasFailedAttachment = false,
}: MessageInputContentInput & {
  hasUploadingAttachment?: boolean;
  hasFailedAttachment?: boolean;
}): boolean {
  if (hasUploadingAttachment || hasFailedAttachment) {
    return false;
  }
  if (text.length > MESSAGE_TEXT_MAX_CHARS) {
    return false;
  }
  return buildMessageInputContentBlocks({ text, readyAttachmentBlocks }).length > 0;
}

export function shouldShowMessageInputCounter(text: string): boolean {
  return text.length >= MESSAGE_TEXT_MAX_CHARS * 0.8;
}

export function isMessageInputOverLimit(text: string): boolean {
  return text.length > MESSAGE_TEXT_MAX_CHARS;
}

export function shouldClearSubmittedDraft({
  currentText,
  currentReplyingToMessageId,
  submitted,
}: {
  currentText: string;
  currentReplyingToMessageId?: string;
  submitted: SubmittedMessageDraft;
}): boolean {
  return (
    currentText === submitted.text && currentReplyingToMessageId === submitted.replyingToMessageId
  );
}

export function clearSubmittedMessageInputDraft({
  controls,
  submittedAttachmentTempIds,
  clearSubmittedFiles,
}: {
  controls?: MessageInputSubmitControls;
  submittedAttachmentTempIds: string[];
  clearSubmittedFiles: (tempIds: string[]) => void;
}): boolean {
  const cleared = controls?.clearDraft() ?? false;
  clearSubmittedFiles(submittedAttachmentTempIds);
  return cleared;
}

export function applyMessageInputTextChange({
  text,
  valueRef,
  setCanSend,
  onTyping,
  readyAttachmentBlocks,
  hasUploadingAttachment,
  hasFailedAttachment,
}: {
  text: string;
  valueRef: DraftRef;
  setCanSend: (canSend: boolean) => void;
  onTyping?: () => void;
  readyAttachmentBlocks?: readonly AttachmentBlock[];
  hasUploadingAttachment?: boolean;
  hasFailedAttachment?: boolean;
}) {
  valueRef.current = text;
  setCanSend(
    canSubmitMessageInputContent({
      text,
      readyAttachmentBlocks,
      hasUploadingAttachment,
      hasFailedAttachment,
    })
  );
  onTyping?.();
}

export function submitMessageInputDraft({
  valueRef,
  replyingToMessageId,
  onSend,
  onSendContentBlocks,
  clearInput,
  setCanSend,
  getCurrentReplyingToMessageId,
  clearOnSubmit = false,
  readyAttachmentBlocks,
  hasUploadingAttachment,
  hasFailedAttachment,
}: {
  valueRef: DraftRef;
  replyingToMessageId?: string;
  onSend: (
    text: string,
    inReplyToMessageId?: string,
    controls?: MessageInputSubmitControls
  ) => void;
  onSendContentBlocks?: (
    content: InputContentBlock[],
    inReplyToMessageId?: string,
    controls?: MessageInputSubmitControls
  ) => void;
  clearInput: () => void;
  setCanSend: (canSend: boolean) => void;
  getCurrentReplyingToMessageId?: () => string | undefined;
  clearOnSubmit?: boolean;
  readyAttachmentBlocks?: readonly AttachmentBlock[];
  hasUploadingAttachment?: boolean;
  hasFailedAttachment?: boolean;
}): SubmittedMessageDraft | null {
  const draft = valueRef.current;
  if (
    !canSubmitMessageInputContent({
      text: draft,
      readyAttachmentBlocks,
      hasUploadingAttachment,
      hasFailedAttachment,
    })
  ) {
    return null;
  }

  const text = draft.trim();
  const content = buildMessageInputContentBlocks({ text: draft, readyAttachmentBlocks });
  const submitted: SubmittedMessageDraft = { content, text, replyingToMessageId };
  const clearDraft = () => {
    if (
      !shouldClearSubmittedDraft({
        currentText: valueRef.current.trim(),
        currentReplyingToMessageId: getCurrentReplyingToMessageId?.() ?? replyingToMessageId,
        submitted,
      })
    ) {
      return false;
    }
    valueRef.current = '';
    clearInput();
    setCanSend(false);
    return true;
  };
  const controls = { clearDraft };
  if (onSendContentBlocks) {
    onSendContentBlocks(content, replyingToMessageId, controls);
  } else {
    onSend(text, replyingToMessageId, controls);
  }
  if (clearOnSubmit) {
    clearDraft();
  }
  return submitted;
}
