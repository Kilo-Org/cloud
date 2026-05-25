import { ATTACHMENT_MAX_BYTES, formatFileSize } from '@kilocode/kilo-chat';

export const MESSAGE_ATTACHMENT_MAX_COUNT = 10;

const DEFAULT_ATTACHMENT_FILENAME = 'Attachment';
const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream';

const ATTACHMENT_ACTION_SHEET_OPTIONS = ['Take photo', 'Photo library', 'Files', 'Cancel'] as const;

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

type MessageAttachment = {
  uri: string;
  filename: string;
  mimeType: string;
  size: number;
  isImage: boolean;
};

type RejectedMessageAttachment = {
  attachment: MessageAttachment;
  reason: 'too-large';
  toast: string;
};

type AttachmentSelectionResult = {
  accepted: MessageAttachment[];
  rejected: RejectedMessageAttachment[];
  truncatedCount: number;
  toast?: string;
};

type AddFilesWithinCapacityInput<TInput> = {
  inputs: readonly TInput[];
  capacity: number;
  addFile: (input: TInput) => string | null;
  onAcceptedFile?: (input: TInput, tempId: string) => void;
  onLimitExceeded: () => void;
};

export function getAttachmentActionSheetConfig(): AttachmentActionSheetConfig {
  return {
    options: ATTACHMENT_ACTION_SHEET_OPTIONS,
    cancelButtonIndex: ATTACHMENT_ACTION_SHEET_OPTIONS.length - 1,
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
  return `You can attach up to ${MESSAGE_ATTACHMENT_MAX_COUNT} files.`;
}

export function buildAttachmentSizeRejectionToast(filename: string): string {
  return `${filename} exceeds the ${formatFileSize(ATTACHMENT_MAX_BYTES)} attachment limit.`;
}

export function addFilesWithinAttachmentCapacity<TInput>({
  inputs,
  capacity,
  addFile,
  onAcceptedFile,
  onLimitExceeded,
}: AddFilesWithinCapacityInput<TInput>) {
  const maxAccepted = Math.max(capacity, 0);
  let acceptedCount = 0;
  let limitExceeded = false;

  for (const input of inputs) {
    if (acceptedCount >= maxAccepted) {
      limitExceeded = true;
    } else {
      const tempId = addFile(input);
      if (tempId !== null) {
        acceptedCount += 1;
        onAcceptedFile?.(input, tempId);
      }
    }
  }

  if (limitExceeded) {
    onLimitExceeded();
  }
}

export function selectAllowedAttachments({
  existing,
  selected,
}: {
  existing: readonly MessageAttachment[];
  selected: readonly NativeAttachmentSelection[];
}): AttachmentSelectionResult {
  const capacity = Math.max(MESSAGE_ATTACHMENT_MAX_COUNT - existing.length, 0);
  const accepted: MessageAttachment[] = [];
  const rejected: RejectedMessageAttachment[] = [];
  let truncatedCount = 0;

  for (const selection of selected) {
    const attachment = normalizeAttachmentSelection(selection);

    if (attachment.size > ATTACHMENT_MAX_BYTES) {
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
    DEFAULT_ATTACHMENT_FILENAME
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
