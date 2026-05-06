import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

type DraftRef = { current: string };

export type MessageInputSubmitControls = {
  clearDraft: () => boolean;
};

type SubmittedMessageDraft = {
  text: string;
  replyingToMessageId?: string;
};

function canSubmitDraft(text: string): boolean {
  return text.trim().length > 0 && text.length <= MESSAGE_TEXT_MAX_CHARS;
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

export function applyMessageInputTextChange({
  text,
  valueRef,
  setCanSend,
  onTyping,
}: {
  text: string;
  valueRef: DraftRef;
  setCanSend: (canSend: boolean) => void;
  onTyping?: () => void;
}) {
  valueRef.current = text;
  setCanSend(canSubmitDraft(text));
  onTyping?.();
}

export function submitMessageInputDraft({
  valueRef,
  replyingToMessageId,
  onSend,
  clearInput,
  setCanSend,
  getCurrentReplyingToMessageId,
  clearOnSubmit = false,
}: {
  valueRef: DraftRef;
  replyingToMessageId?: string;
  onSend: (
    text: string,
    inReplyToMessageId?: string,
    controls?: MessageInputSubmitControls
  ) => void;
  clearInput: () => void;
  setCanSend: (canSend: boolean) => void;
  getCurrentReplyingToMessageId?: () => string | undefined;
  clearOnSubmit?: boolean;
}): SubmittedMessageDraft | null {
  const draft = valueRef.current;
  if (!canSubmitDraft(draft)) {
    return null;
  }

  const text = draft.trim();
  const submitted: SubmittedMessageDraft = { text, replyingToMessageId };
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
  onSend(text, replyingToMessageId, { clearDraft });
  if (clearOnSubmit) {
    clearDraft();
  }
  return submitted;
}
