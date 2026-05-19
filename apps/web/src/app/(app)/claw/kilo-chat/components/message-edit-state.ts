import {
  MESSAGE_TEXT_MAX_CHARS,
  type AttachmentBlock,
  type ContentBlock,
} from '@kilocode/kilo-chat';

export type MessageEditHandler = (messageId: string, content: ContentBlock[]) => Promise<boolean>;

export function isMessageEditOverLimit(text: string): boolean {
  return text.length > MESSAGE_TEXT_MAX_CHARS;
}

export type BuildEditContentInput = {
  text: string;
  originalAttachments: AttachmentBlock[];
  removedIds: Set<string>;
};

export function buildEditContent(input: BuildEditContentInput): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const trimmed = input.text.trim();
  if (trimmed.length > 0) blocks.push({ type: 'text', text: trimmed });
  for (const att of input.originalAttachments) {
    if (!input.removedIds.has(att.attachmentId)) blocks.push(att);
  }
  return blocks;
}

export type SubmitMessageEditInput = {
  messageId: string;
  editText: string;
  originalText: string;
  originalAttachments: AttachmentBlock[];
  removedAttachmentIds: Set<string>;
  onEdit: MessageEditHandler;
  closeEditor: () => void;
};

export async function submitMessageEdit({
  messageId,
  editText,
  originalText,
  originalAttachments,
  removedAttachmentIds,
  onEdit,
  closeEditor,
}: SubmitMessageEditInput): Promise<boolean> {
  if (isMessageEditOverLimit(editText)) {
    return false;
  }
  const trimmed = editText.trim();
  const remainingAttachmentsCount = originalAttachments.filter(
    a => !removedAttachmentIds.has(a.attachmentId)
  ).length;
  if (trimmed.length === 0 && remainingAttachmentsCount === 0) {
    return false;
  }

  const textUnchanged = trimmed === originalText.trim();
  const nothingRemoved = removedAttachmentIds.size === 0;
  if (textUnchanged && nothingRemoved) {
    closeEditor();
    return true;
  }

  const content = buildEditContent({
    text: editText,
    originalAttachments,
    removedIds: removedAttachmentIds,
  });
  try {
    const saved = await onEdit(messageId, content);
    if (!saved) return false;
    closeEditor();
    return true;
  } catch {
    return false;
  }
}
