type DraftRef = { current: string };

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
  setCanSend(text.trim().length > 0);
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
  const text = valueRef.current.trim();
  if (!text) {
    return false;
  }

  onSend(text, replyingToMessageId);
  valueRef.current = '';
  clearInput();
  setCanSend(false);
  return true;
}
