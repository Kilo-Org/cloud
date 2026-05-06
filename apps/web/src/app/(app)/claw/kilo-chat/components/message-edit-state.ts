import { MESSAGE_TEXT_MAX_CHARS, type ContentBlock } from '@kilocode/kilo-chat';

export type MessageEditHandler = (messageId: string, content: ContentBlock[]) => Promise<boolean>;

export function isMessageEditOverLimit(text: string): boolean {
  return text.length > MESSAGE_TEXT_MAX_CHARS;
}

export async function submitMessageEdit({
  messageId,
  editText,
  originalText,
  onEdit,
  closeEditor,
}: {
  messageId: string;
  editText: string;
  originalText: string;
  onEdit: MessageEditHandler;
  closeEditor: () => void;
}): Promise<boolean> {
  const trimmed = editText.trim();
  if (!trimmed || isMessageEditOverLimit(editText)) {
    return false;
  }

  if (trimmed === originalText.trim()) {
    closeEditor();
    return true;
  }

  try {
    const saved = await onEdit(messageId, [{ type: 'text', text: trimmed }]);
    if (!saved) {
      return false;
    }
    closeEditor();
    return true;
  } catch {
    return false;
  }
}
