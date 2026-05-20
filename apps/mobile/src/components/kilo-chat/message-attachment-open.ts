type AttachmentImageRenderState = 'loading' | 'ready' | 'error';

const ATTACHMENT_OPEN_ERROR_MESSAGE =
  "Couldn't open attachment. Check your connection and try again.";

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
}): Promise<string> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const directory = new Directory(Paths.cache, 'kilo-chat-attachments');
  directory.create({ idempotent: true, intermediates: true });

  const file = new File(directory, `${safePathSegment(attachmentId)}-${safePathSegment(filename)}`);
  const downloaded = await File.downloadFileAsync(url, file, { idempotent: true });
  return downloaded.uri;
}

async function shareLocalFile(localUri: string): Promise<void> {
  const Sharing = await import('expo-sharing');
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
  const localUri = await materializeRemoteAttachment(input);
  await shareLocalFile(localUri);
}

function safePathSegment(value: string): string {
  const sanitized = value.trim().replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'attachment';
}
