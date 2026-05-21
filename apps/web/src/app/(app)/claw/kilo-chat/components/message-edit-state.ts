import {
  MESSAGE_TEXT_MAX_CHARS,
  buildMessageEditContent,
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

// Edit normalizes the message body to `(text? + attachments[])`. Any other
// block type on the original message (e.g. `actions`) is dropped, which is
// intentional: user-authored messages should never carry those, and rebuilding
// on save lets us keep the editor surface simple. If user messages ever gain a
// new block type, this needs to either pass it through or reject the edit.
export function buildEditContent(input: BuildEditContentInput): ContentBlock[] {
  return buildMessageEditContent({
    text: input.text,
    originalAttachments: input.originalAttachments,
    removedAttachmentIds: input.removedIds,
  });
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
