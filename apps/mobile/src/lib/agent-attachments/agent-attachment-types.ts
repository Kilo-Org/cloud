/**
 * Pure helpers extracted from `use-agent-attachment-upload` so the
 * upload contract is unit-testable without React or React Native
 * (vitest's node environment cannot parse the Flow-typed
 * `react-native/index.js` that `sonner-native` and friends pull in).
 * The hook re-exports these symbols so existing call sites keep
 * importing from one place.
 */

import { type AgentAttachmentExtension, type AgentAttachmentMime } from './constants';

export type AgentAttachmentKind = 'image' | 'document';
export type AgentAttachmentStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AgentAttachment = {
  id: string;
  /** Original filename as supplied by the picker. Display-only. */
  filename: string;
  /** Basename of the server-side R2 key; set once the upload succeeds. */
  remoteFilename?: string;
  kind: AgentAttachmentKind;
  /** Normalized extension used for the R2 key suffix and MIME derivation. */
  extension: AgentAttachmentExtension;
  mimeType: AgentAttachmentMime;
  /**
   * Measured local byte size (via `getInfoAsync`). The picker-reported
   * `size` is unreliable on iOS so we always re-measure before adding
   * the candidate to state.
   */
  size: number;
  localUri: string;
  status: AgentAttachmentStatus;
  /** Human-readable error for retryable failures; the chip is the affordance. */
  error?: string;
  /** True when the server rejected this attachment permanently. */
  terminal?: boolean;
  /** 0..1 determinate progress; `null` when progress is unavailable. */
  progress: number | null;
};

export type AgentAttachmentWire = {
  path: string;
  files: string[];
};

/**
 * Composer submission payload. The wire is the existing
 * `{path, files}` shape consumed by the cloud-agent SDK; `messageUuid`
 * and the per-file descriptor are new in S2 and are the contract S3b
 * consumes to materialize the cloud `{path, files}` materialization.
 *
 * NOTE: there is NO `mime` field on the descriptor. Every consumer
 * derives MIME from the validated `remoteName` extension.
 */
export type AgentAttachmentSubmissionFile = {
  remoteName: string;
  originalName: string;
  size: number;
};

export type AgentAttachmentSubmissionPayload = {
  wire: AgentAttachmentWire;
  messageUuid: string;
  files: AgentAttachmentSubmissionFile[];
};

/**
 * Status code → retryable / terminal classifier (pinned by the plan).
 * Terminal set: presign BAD_REQUEST / FORBIDDEN / UNPROCESSABLE_CONTENT /
 * UNAUTHORIZED / NOT_FOUND — these are policy rejections and must never
 * be retried. Anything else the upload task throws (network, timeout,
 * 408/429/5xx, generic PUT failure) is retryable.
 */
export function classifyUploadFailure(error: unknown): { retryable: boolean; reason: string } {
  // The mutation throws `TRPCClientError<AppRouterException>` for
  // BAD_REQUEST / FORBIDDEN / UNPROCESSABLE_CONTENT — those are TERMINAL.
  // Any other thrown object (network, timeout, expiry, etc.) is RETRYABLE.
  const code = (error as { data?: { code?: string; message?: string } } | null)?.data?.code;
  const dataMessage = (error as { data?: { code?: string; message?: string } } | null)?.data
    ?.message;
  if (code === 'BAD_REQUEST' || code === 'FORBIDDEN' || code === 'UNPROCESSABLE_CONTENT') {
    return { retryable: false, reason: dataMessage ?? "This file can't be uploaded." };
  }
  if (code === 'UNAUTHORIZED' || code === 'NOT_FOUND') {
    return { retryable: false, reason: dataMessage ?? "This file can't be uploaded." };
  }
  if (error instanceof TypeError) {
    return { retryable: true, reason: 'Network error' };
  }
  if (error instanceof Error) {
    if (/abort|cancel|expir/i.test(error.message)) {
      return { retryable: true, reason: 'Upload failed' };
    }
    if (/status (408|429|5\d\d)/.test(error.message)) {
      return { retryable: true, reason: 'Upload failed' };
    }
    if (/status \d{3}/.test(error.message)) {
      // Any other HTTP error (4xx other than the terminal codes above,
      // 5xx, etc.) is retryable — the plan pins PUT failures as retryable.
      return { retryable: true, reason: 'Upload failed' };
    }
    return { retryable: true, reason: 'Upload failed' };
  }
  return { retryable: true, reason: 'Upload failed' };
}

/**
 * Build the `{path, files}` wire payload from the current attachments.
 * Pure: the hook is just a memoized wrapper.
 */
export function buildWirePayload(
  attachments: AgentAttachment[],
  path: string
): AgentAttachmentWire | undefined {
  const files = attachments
    .filter(item => item.status === 'uploaded')
    .map(item => item.remoteFilename)
    .filter((filename): filename is string => filename !== undefined);
  if (files.length === 0) {
    return undefined;
  }
  return { path, files };
}

/**
 * Build the S2 submission payload from the current attachments. `wire` is
 * the existing `{path, files}` shape; `messageUuid` and the per-file
 * descriptor are new in S2 and are what S3b consumes to materialize the
 * cloud `{path, files}` materialization. There is NO `mime` field on the
 * descriptor — every consumer derives MIME from the validated `remoteName`
 * extension. Pure: the hook is just a memoized wrapper.
 */
export function buildSubmissionPayload(
  attachments: AgentAttachment[],
  path: string,
  messageUuid: string
): AgentAttachmentSubmissionPayload | undefined {
  const ready: { remoteFilename: string; filename: string; size: number }[] = [];
  for (const item of attachments) {
    if (item.status === 'uploaded' && item.remoteFilename !== undefined) {
      ready.push({
        remoteFilename: item.remoteFilename,
        filename: item.filename,
        size: item.size,
      });
    }
  }
  if (ready.length === 0) {
    return undefined;
  }
  return {
    wire: { path, files: ready.map(item => item.remoteFilename) },
    messageUuid,
    files: ready.map(item => ({
      remoteName: item.remoteFilename,
      originalName: item.filename,
      size: item.size,
    })),
  };
}

/** True when any chip is mid-flight (pending or uploading). */
export function isAnyAttachmentUploading(attachments: AgentAttachment[]): boolean {
  return attachments.some(item => item.status === 'pending' || item.status === 'uploading');
}

/** True when any chip is in a failed state (retryable or terminal). */
export function hasAnyFailedAttachment(attachments: AgentAttachment[]): boolean {
  return attachments.some(item => item.status === 'error');
}
