import {
  getSafeCacheFilename,
  getShareRemoteFileReason,
  type MaterializedRemoteFile,
  shareLocalFile,
  shareMaterializedRemoteFile,
  shareRemoteFile,
} from '@/lib/share-remote-file';

type AttachmentImageRenderState = 'loading' | 'ready' | 'error';

const ATTACHMENT_CACHE_DIRECTORY = 'kilo-chat-attachments';
const ATTACHMENT_OPEN_ERROR_MESSAGE =
  "Couldn't open attachment. Check your connection and try again.";

type MaterializedAttachment = MaterializedRemoteFile;

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

export async function shareRemoteAttachment(input: {
  url: string;
  attachmentId: string;
  filename: string;
}): Promise<void> {
  try {
    await shareRemoteFile({
      url: input.url,
      cacheDirectoryName: ATTACHMENT_CACHE_DIRECTORY,
      cacheKey: input.attachmentId,
      filename: input.filename,
    });
  } catch (error) {
    if (getShareRemoteFileReason(error) !== null) {
      throw new Error(getAttachmentOpenErrorMessage(), { cause: error });
    }
    throw error;
  }
}

export async function shareMaterializedAttachment(
  attachment: MaterializedAttachment,
  shareFile: (uri: string) => Promise<void> = shareLocalFile
): Promise<void> {
  try {
    await shareMaterializedRemoteFile(attachment, shareFile);
  } catch (error) {
    if (getShareRemoteFileReason(error) !== null) {
      throw new Error(getAttachmentOpenErrorMessage(), { cause: error });
    }
    throw error;
  }
}

export function getAttachmentCacheFilename({
  attachmentId,
  filename,
}: {
  attachmentId: string;
  filename: string;
}): string {
  return getSafeCacheFilename({ id: attachmentId, filename });
}
