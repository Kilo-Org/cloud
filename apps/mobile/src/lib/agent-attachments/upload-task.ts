import { createUploadTask, FileSystemUploadType, getInfoAsync } from 'expo-file-system/legacy';

import { i18n } from '@/i18n';
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
 * (`null` when the server omits Content-Length). `onAdmitted` fires once the
 * presign admits the object key into the pending-upload ledger, before the PUT
 * starts, so a later remove/leave can release the row even when the PUT fails.
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
  onTask?: (task: { cancelAsync: () => Promise<void> }) => void;
  onAdmitted?: (key: string) => void;
  isCancelled?: () => boolean;
}): Promise<UploadOutcome> {
  const {
    organizationId,
    attachmentId,
    path,
    contentType,
    contentLength,
    localUri,
    onProgress,
    onTask,
    onAdmitted,
    isCancelled,
  } = args;
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

  if (isCancelled?.()) {
    throw new Error('Upload cancelled');
  }
  // Admit the key before the PUT: the presign already created the pending
  // ledger row, so a remove/leave that races the PUT must still release it.
  onAdmitted?.(result.key);

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
  onTask?.(task);
  const uploadResult = await task.uploadAsync();
  if (!uploadResult || uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Upload failed with status ${uploadResult?.status ?? 'no response'}`);
  }
  return { key: result.key };
}

/** Chip/toast copy for terminal (non-retryable) upload failures. */
export function describeTerminalReason(_reason: string): string {
  return i18n.t('chat.attachment.cantUpload');
}

/**
 * Release abandoned composer files' pending-ledger rows so they stop consuming
 * the per-message quota before the 24-hour reaper would clear them. Mirrors
 * `getAttachmentUploadUrl`'s personal/organization split: the organization
 * mutation adds `organizationId` and gates membership.
 */
export async function releasePendingUploads(args: {
  organizationId?: string;
  objectKeys: string[];
}): Promise<void> {
  const { organizationId, objectKeys } = args;
  if (objectKeys.length === 0) {
    return;
  }
  if (organizationId) {
    await trpcClient.organizations.cloudAgentNext.releasePendingUploads.mutate({
      objectKeys,
      organizationId,
    });
    return;
  }
  await trpcClient.cloudAgentNext.releasePendingUploads.mutate({ objectKeys });
}
