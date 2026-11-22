import { File, UploadType } from 'expo-file-system';

import { i18n } from '@/i18n';
import { trpcClient } from '@/lib/trpc';
import {
  type AgentAttachmentExtension,
  type AgentAttachmentMime,
} from '@/lib/agent-attachments/constants';
import { NativeUploadProgress } from '@/lib/native-transfer-progress';

export function normalizeFilename(name: string, extension: AgentAttachmentExtension): string {
  // If the original filename had no usable extension we append the
  // normalized one so the display value and the server's R2 key agree.
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return name;
  }
  return `${name}.${extension}`;
}

// eslint-disable-next-line require-await -- the modern File API exposes size synchronously; the public signature stays async for callers.
export async function measureLocalSize(uri: string): Promise<number | null> {
  try {
    const file = new File(uri);
    if (file.exists) {
      return file.size;
    }
  } catch {
    return null;
  }
  return null;
}

type UploadOutcome = { key: string };

/**
 * How long a native upload may go without a progress event before it settles as
 * stalled. It bounds inactivity, not total time: a slow but progressing upload
 * of the 20 MB ceiling is never failed by a clock, while a transfer that stops
 * moving settles in seconds instead of pinning the chip in `uploading` and
 * blocking Send for as long as the connection hangs.
 */
export const AGENT_ATTACHMENT_UPLOAD_STALL_MS = 20_000;

/**
 * The app's foreground signal, as one subscription. `uploadOne` stays free of
 * `react-native` imports so its contract runs in the node test project; the
 * caller that owns the app shell supplies the real source.
 */
export type ForegroundSource = {
  addEventListener(type: 'change', handler: (state: string) => void): { remove(): void };
};

let foregroundSource: ForegroundSource | undefined = undefined;

/**
 * Registers the app's `AppState`-shaped source for the stall window. The app
 * root calls this once; without it the window measures wall-clock inactivity,
 * which is correct on Android and for a foreground iOS transfer.
 */
export function setUploadForegroundSource(source: ForegroundSource): void {
  foregroundSource = source;
}

/**
 * One inactivity window for one native transfer. `touch()` arms it at the
 * start and re-arms it from every progress event; `run()` disarms it however
 * the transfer settles, so a window never outlives the upload it bounds.
 *
 * The window only counts foreground time. An iOS upload runs in a background
 * URLSession and keeps moving while the app is suspended, but JavaScript timers
 * do not fire there: an expired timer would then fire the moment the app
 * returns, before the progress events the transfer queued are delivered, and
 * cancel an upload that was never stuck. Leaving the foreground therefore
 * suspends the window and returning re-arms it.
 */
function uploadStallWindow() {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  let running = false;
  let suspended = false;
  let stall = (): void => undefined;

  const disarm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** Arms the window; a progress event after the transfer settled is ignored. */
  const touch = (): void => {
    if (!running || suspended) {
      return;
    }
    disarm();
    timer = setTimeout(() => {
      timer = undefined;
      stall();
    }, AGENT_ATTACHMENT_UPLOAD_STALL_MS);
  };

  const subscription = foregroundSource?.addEventListener('change', next => {
    if (!running) {
      return;
    }
    if (next === 'active') {
      suspended = false;
      touch();
      return;
    }
    suspended = true;
    disarm();
  });

  /**
   * Runs `task.uploadAsync()` under the window. A stall settles the awaited
   * promise first with `Upload stalled` and only then cancels the native
   * request, so a late native outcome cannot win and its rejection is already
   * handled by the race below rather than escaping as an unhandled rejection.
   */
  const run = async <T>(task: {
    uploadAsync: () => Promise<T>;
    cancel: () => void;
  }): Promise<T> => {
    const stalled = Promise.withResolvers<never>();
    stall = () => {
      stalled.reject(new Error('Upload stalled'));
      task.cancel();
    };
    running = true;
    suspended = false;
    try {
      const transfer = task.uploadAsync();
      touch();
      return await Promise.race([transfer, stalled.promise]);
    } finally {
      running = false;
      stall = (): void => undefined;
      disarm();
      subscription?.remove();
    }
  };

  return { touch, run };
}

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
  onTask?: (task: { cancel: () => void }) => void;
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
    // The presign already admitted a pending-ledger row for this key. Nothing
    // else holds it: the chip that owned the upload is gone, so `onAdmitted`
    // would write the key to a removed chip. Release it here, where the row was
    // created, and swallow a failed release: the 24-hour reaper still covers it.
    try {
      await releasePendingUploads({ organizationId, objectKeys: [result.key] });
    } catch {
      // Best-effort: a failed release must not turn a cancel into a failure.
    }
    throw new Error('Upload cancelled');
  }
  // Admit the key before the PUT: the presign already created the pending
  // ledger row, so a remove/leave that races the PUT must still release it.
  onAdmitted?.(result.key);

  // Per-chip determinate progress via the modern `File.createUploadTask`. A
  // signed-URL PUT only reports progress when the response advertises
  // Content-Length; we fall back to `null` (indeterminate) when the server
  // omits it. Every progress event, determinate or not, proves the transfer is
  // still moving, so each one re-arms the stall window.
  const bounds = uploadStallWindow();
  const task = new File(localUri).createUploadTask(result.signedUrl, {
    uploadType: UploadType.BINARY_CONTENT,
    httpMethod: 'PUT',
    headers: { 'Content-Type': contentType },
    onProgress: progress => {
      const parsed = NativeUploadProgress.safeParse(progress);
      if (parsed.success && parsed.data.totalBytes > 0) {
        onProgress(parsed.data.bytesSent / parsed.data.totalBytes);
      } else {
        onProgress(null);
      }
      bounds.touch();
    },
  });
  onTask?.(task);
  const uploadResult = await bounds.run(task);
  if (uploadResult.status < 200 || uploadResult.status >= 300) {
    throw new Error(`Upload failed with status ${uploadResult.status}`);
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
