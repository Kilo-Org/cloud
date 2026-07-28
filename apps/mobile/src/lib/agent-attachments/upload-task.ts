import { createUploadTask, FileSystemUploadType, getInfoAsync } from 'expo-file-system/legacy';

import { trpcClient } from '@/lib/trpc';
import {
  type AgentAttachmentExtension,
  type AgentAttachmentMime,
} from '@/lib/agent-attachments/constants';

export function normalizeFilename(name: string, extension: AgentAttachmentExtension): string {
  // If the original filename had no usable extension we append the
  // normalized one so the display value and the server's R2 key agree.
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return name;
  }
  return `${name}.${extension}`;
}

export async function measureLocalSize(uri: string): Promise<number | null> {
  try {
    const info = await getInfoAsync(uri);
    if (info.exists && !info.isDirectory) {
      return info.size;
    }
  } catch {
    return null;
  }
  return null;
}

type UploadOutcome = { key: string };

/**
 * Presign + PUT a single local file. Progress is reported via `onProgress`
 * (`null` when the server omits Content-Length).
 */
export async function uploadOne(args: {
  organizationId?: string;
  attachmentId: string;
  path: string;
  extension: AgentAttachmentExtension;
  contentType: AgentAttachmentMime;
  contentLength: number;
  localUri: string;
  onProgress: (progress: number | null) => void;
}): Promise<UploadOutcome> {
  const { organizationId, attachmentId, path, contentType, contentLength, localUri, onProgress } =
    args;
  const baseInput = {
    messageUuid: path,
    attachmentId,
    contentType,
    contentLength,
    extension: args.extension,
  };
  const result = organizationId
    ? await trpcClient.organizations.cloudAgentNext.getAttachmentUploadUrl.mutate({
        ...baseInput,
        organizationId,
      })
    : await trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate(baseInput);

  // Per-chip determinate progress via `createUploadTask` (the
  // main-module `createUploadTask` throws at runtime in SDK 55, so we
  // import from `expo-file-system/legacy`). A signed-URL PUT only
  // reports progress when the response advertises Content-Length; we
  // fall back to `null` (indeterminate) when the server omits it.
  const task = createUploadTask(
    result.signedUrl,
    localUri,
    {
      uploadType: FileSystemUploadType.BINARY_CONTENT,
      httpMethod: 'PUT',
      headers: { 'Content-Type': contentType },
    },
    progress => {
      const total = progress.totalBytesExpectedToSend;
      if (total > 0) {
        onProgress(progress.totalBytesSent / total);
      } else {
        onProgress(null);
      }
    }
  );
  const uploadResult = await task.uploadAsync();
  if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Upload failed with status ${uploadResult?.status ?? 'no response'}`);
  }
  return { key: result.key };
}

/** Chip/toast copy for terminal (non-retryable) upload failures. */
export function describeTerminalReason(_reason: string): string {
  return "This file can't be uploaded.";
}
