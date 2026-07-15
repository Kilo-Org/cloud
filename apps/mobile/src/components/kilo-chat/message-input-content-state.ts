import { type AttachmentBlock } from '@kilocode/kilo-chat';
import { type QueuedAttachment } from '@kilocode/kilo-chat-hooks';

export function resolveMessageInputSendDisabled({
  canSend,
  disabled,
  overLimit,
}: {
  canSend: boolean;
  disabled?: boolean;
  overLimit: boolean;
}): boolean {
  return !canSend || disabled === true || overLimit;
}

export function editableAttachmentToPreviewRow(attachment: AttachmentBlock): QueuedAttachment {
  return {
    tempId: attachment.attachmentId,
    attachmentId: attachment.attachmentId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    status: 'ready',
    progress: 1,
  };
}
