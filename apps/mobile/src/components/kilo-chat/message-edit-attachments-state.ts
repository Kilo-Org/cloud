import { type AttachmentBlock, type InputContentBlock } from '@kilocode/kilo-chat';

export function remainingEditableAttachments(
  originalAttachments: readonly AttachmentBlock[],
  removedAttachmentIds: readonly string[]
): AttachmentBlock[] {
  const removedAttachmentIdSet = new Set(removedAttachmentIds);
  return originalAttachments.filter(
    attachment => !removedAttachmentIdSet.has(attachment.attachmentId)
  );
}

export function buildMobileEditContent({
  text,
  originalAttachments,
  removedAttachmentIds,
}: {
  text: string;
  originalAttachments: readonly AttachmentBlock[];
  removedAttachmentIds: readonly string[];
}): InputContentBlock[] {
  const trimmedText = text.trim();
  const textBlocks: InputContentBlock[] =
    trimmedText.length > 0 ? [{ type: 'text', text: trimmedText }] : [];
  return [
    ...textBlocks,
    ...remainingEditableAttachments(originalAttachments, removedAttachmentIds),
  ];
}
