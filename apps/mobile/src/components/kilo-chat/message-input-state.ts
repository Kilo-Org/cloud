import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

type DraftRef = { current: string };

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
}: {
  valueRef: DraftRef;
  replyingToMessageId?: string;
  onSend: (text: string, inReplyToMessageId?: string) => void;
  clearInput: () => void;
  setCanSend: (canSend: boolean) => void;
}) {
  const draft = valueRef.current;
  if (!canSubmitDraft(draft)) {
    return false;
  }

  const text = draft.trim();
  onSend(text, replyingToMessageId);
  valueRef.current = '';
  clearInput();
  setCanSend(false);
  return true;
}
