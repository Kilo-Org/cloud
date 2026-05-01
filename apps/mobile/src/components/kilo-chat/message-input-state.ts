import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

type DraftRef = { current: string };

export type MessageInputSubmitControls = {
  clearDraft: () => void;
};

function canSubmitDraft(text: string): boolean {
  return text.trim().length > 0 && text.length <= MESSAGE_TEXT_MAX_CHARS;
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
  clearOnSubmit = true,
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
  clearOnSubmit?: boolean;
}) {
  const draft = valueRef.current;
  if (!canSubmitDraft(draft)) {
    return false;
  }

  const text = draft.trim();
  const clearDraft = () => {
    valueRef.current = '';
    clearInput();
    setCanSend(false);
  };
  onSend(text, replyingToMessageId, { clearDraft });
  if (clearOnSubmit) {
    clearDraft();
  }
  return true;
}
