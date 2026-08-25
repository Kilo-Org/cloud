import { i18n } from '@/i18n';
import { formatFileSize } from '@/lib/format';

const MESSAGE_ATTACHMENT_MAX_COUNT = 10;

/**
 * Mobile-only per-attachment byte cap, deliberately far below the shared
 * `ATTACHMENT_MAX_BYTES` (100 MiB). Picking an attachment materializes the
 * whole file twice — once as a JS `ArrayBuffer`, once as a `ByteArray` in
 * React Native's blob store on the Java heap — and up to
 * `MESSAGE_ATTACHMENT_MAX_COUNT` of them stay resident until the message is
 * sent. 10 MiB keeps the worst case (10 files) at ~100 MiB, inside an Android
 * heap growth limit of ~268 MB. The shared constant governs the server and the
 * web client and is intentionally left alone.
 */
export const MOBILE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

type AttachmentActionSheetConfig = {
  options: readonly string[];
  cancelButtonIndex: number;
};

export type NativeAttachmentSelection = {
  uri: string;
  name?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
  fileSize?: number | null;
};

export type MessageAttachment = {
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  isImage: boolean;
};

type RejectedMessageAttachment = {
  attachment: MessageAttachment;
  reason: 'too-large' | 'unreadable';
  toast: string;
};

type AttachmentSelectionResult = {
  accepted: MessageAttachment[];
  rejected: RejectedMessageAttachment[];
  truncatedCount: number;
  toast?: string;
};

export function getAttachmentActionSheetConfig(): AttachmentActionSheetConfig {
  const options = [
    i18n.t('chat.attachmentPicker.takePhoto'),
    i18n.t('chat.attachmentPicker.photoLibrary'),
    i18n.t('chat.attachmentPicker.files'),
    i18n.t('common.cancel'),
  ];
  return {
    options,
    cancelButtonIndex: options.length - 1,
  };
}

export function isImageMimeType(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith('image/') ?? false;
}

export function normalizeAttachmentSelection(
  selection: NativeAttachmentSelection
): MessageAttachment {
  const mimeType = normalizedText(selection.mimeType) ?? DEFAULT_ATTACHMENT_MIME_TYPE;

  return {
    uri: selection.uri,
    filename: filenameFromSelection(selection),
    mimeType,
    size: sizeFromSelection(selection),
    isImage: isImageMimeType(mimeType),
  };
}

export function buildAttachmentLimitToast(): string {
  return i18n.t('chat.attachment.limit', { count: MESSAGE_ATTACHMENT_MAX_COUNT });
}

export function buildAttachmentSizeRejectionToast(filename: string): string {
  return i18n.t('chat.attachment.sizeRejection', {
    filename,
    limit: formatFileSize(MOBILE_ATTACHMENT_MAX_BYTES, i18n.language),
  });
}

export function buildAttachmentUnreadableToast(filename: string): string {
  return i18n.t('chat.attachment.unreadable', { filename });
}

export function selectAllowedAttachments({
  existingCount,
  selected,
}: {
  existingCount: number;
  selected: readonly MessageAttachment[];
}): AttachmentSelectionResult {
  const capacity = Math.max(MESSAGE_ATTACHMENT_MAX_COUNT - existingCount, 0);
  const accepted: MessageAttachment[] = [];
  const rejected: RejectedMessageAttachment[] = [];
  let truncatedCount = 0;

  for (const attachment of selected) {
    if (attachment.size <= 0) {
      // Fail closed: `sizeFromSelection` collapses a missing, null, non-finite
      // or negative size to 0, and materializing a file we could not measure is
      // exactly the unbounded read this gate exists to prevent. A genuinely
      // empty file is also not worth uploading — the cloud-agent path rejects
      // `size <= 0` for the same reason (`lib/agent-attachments/validate.ts`).
      rejected.push({
        attachment,
        reason: 'unreadable',
        toast: buildAttachmentUnreadableToast(attachment.filename),
      });
    } else if (attachment.size > MOBILE_ATTACHMENT_MAX_BYTES) {
      rejected.push({
        attachment,
        reason: 'too-large',
        toast: buildAttachmentSizeRejectionToast(attachment.filename),
      });
    } else if (accepted.length >= capacity) {
      truncatedCount += 1;
    } else {
      accepted.push(attachment);
    }
  }

  return {
    accepted,
    rejected,
    truncatedCount,
    toast: selectionToast({ rejected, truncatedCount }),
  };
}

function selectionToast({
  rejected,
  truncatedCount,
}: {
  rejected: readonly RejectedMessageAttachment[];
  truncatedCount: number;
}): string | undefined {
  if (rejected.length > 0) {
    return rejected[0]?.toast;
  }

  if (truncatedCount > 0) {
    return buildAttachmentLimitToast();
  }

  return undefined;
}

function filenameFromSelection(selection: NativeAttachmentSelection): string {
  return (
    normalizedText(selection.name) ??
    normalizedText(selection.fileName) ??
    filenameFromUri(selection.uri) ??
    i18n.t('chat.attachment.defaultName')
  );
}

function filenameFromUri(uri: string): string | undefined {
  const lastSlashIndex = uri.lastIndexOf('/');
  const lastSegment = uri.slice(lastSlashIndex + 1);
  const decoded = safelyDecodeURIComponent(lastSegment);
  if (!decoded?.includes('.')) {
    return undefined;
  }
  return normalizedText(decoded);
}

function sizeFromSelection(selection: NativeAttachmentSelection): number {
  const size = selection.size ?? selection.fileSize ?? 0;
  if (!Number.isFinite(size) || size < 0) {
    return 0;
  }
  return size;
}

function normalizedText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function safelyDecodeURIComponent(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
