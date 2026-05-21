import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

type AttachmentImageRenderState = 'loading' | 'ready' | 'error';

const MAX_CACHE_FILENAME_BYTES = 255;
const ONE_BYTE_CODE_POINT_MAX = 127;
const TWO_BYTE_CODE_POINT_MAX = 2047;
const THREE_BYTE_CODE_POINT_MAX = 65_535;
const ATTACHMENT_OPEN_ERROR_MESSAGE =
  "Couldn't open attachment. Check your connection and try again.";

type MaterializedAttachment = {
  uri: string;
  delete: () => void;
};

export function getAttachmentImageRenderState({
  hasUrl,
  isError,
  isLoading,
}: {
  hasUrl: boolean;
  isError: boolean;
  isLoading: boolean;
}): AttachmentImageRenderState {
  if (isError) {
    return 'error';
  }

  if (isLoading || !hasUrl) {
    return 'loading';
  }

  return 'ready';
}

export function getAttachmentOpenErrorMessage(): string {
  return ATTACHMENT_OPEN_ERROR_MESSAGE;
}

export function getFreshAttachmentPreviewUrl(
  data: { url?: string | null } | null | undefined
): string | null {
  return data?.url ?? null;
}

async function materializeRemoteAttachment({
  url,
  attachmentId,
  filename,
}: {
  url: string;
  attachmentId: string;
  filename: string;
}): Promise<MaterializedAttachment> {
  const directory = new Directory(Paths.cache, 'kilo-chat-attachments');
  directory.create({ idempotent: true, intermediates: true });

  const file = new File(directory, getAttachmentCacheFilename({ attachmentId, filename }));
  const downloaded = await File.downloadFileAsync(url, file, { idempotent: true });
  return {
    uri: downloaded.uri,
    delete: () => {
      downloaded.delete();
    },
  };
}

async function shareLocalFile(localUri: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error(getAttachmentOpenErrorMessage());
  }

  await Sharing.shareAsync(localUri);
}

export async function shareRemoteAttachment(input: {
  url: string;
  attachmentId: string;
  filename: string;
}): Promise<void> {
  const attachment = await materializeRemoteAttachment(input);
  await shareMaterializedAttachment(attachment);
}

export async function shareMaterializedAttachment(
  attachment: MaterializedAttachment,
  shareFile: (uri: string) => Promise<void> = shareLocalFile
): Promise<void> {
  try {
    await shareFile(attachment.uri);
    if (Platform.OS !== 'android') {
      attachment.delete();
    }
  } catch (error) {
    attachment.delete();
    throw error;
  }
}

function safePathSegment(value: string): string {
  const sanitized = value.trim().replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'attachment';
}

export function getAttachmentCacheFilename({
  attachmentId,
  filename,
}: {
  attachmentId: string;
  filename: string;
}): string {
  const prefix = `${safePathSegment(attachmentId)}-`;
  const filenameBudget = MAX_CACHE_FILENAME_BYTES - utf8ByteLength(prefix);

  if (filenameBudget <= 0) {
    return truncateUtf8(prefix, MAX_CACHE_FILENAME_BYTES);
  }

  return `${prefix}${boundFilenameSegment(safePathSegment(filename), filenameBudget)}`;
}

function boundFilenameSegment(filename: string, maxBytes: number): string {
  if (utf8ByteLength(filename) <= maxBytes) {
    return filename;
  }

  const extension = getExtension(filename);
  const extensionBytes = utf8ByteLength(extension);
  if (extension.length > 0 && extensionBytes < maxBytes) {
    const stem = filename.slice(0, -extension.length);
    const truncatedStem = truncateUtf8(stem, maxBytes - extensionBytes);
    if (truncatedStem.length > 0) {
      return `${truncatedStem}${extension}`;
    }
  }

  return truncateUtf8(filename, maxBytes);
}

function getExtension(filename: string): string {
  const extensionStart = filename.lastIndexOf('.');
  if (extensionStart <= 0 || extensionStart === filename.length - 1) {
    return '';
  }

  return filename.slice(extensionStart);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8CodePointByteLength(character);
  }
  return bytes;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';

  for (const character of value) {
    const characterBytes = utf8CodePointByteLength(character);
    if (bytes + characterBytes > maxBytes) {
      break;
    }

    bytes += characterBytes;
    result += character;
  }

  return result;
}

function utf8CodePointByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= ONE_BYTE_CODE_POINT_MAX) {
    return 1;
  }
  if (codePoint <= TWO_BYTE_CODE_POINT_MAX) {
    return 2;
  }
  if (codePoint <= THREE_BYTE_CODE_POINT_MAX) {
    return 3;
  }
  return 4;
}
