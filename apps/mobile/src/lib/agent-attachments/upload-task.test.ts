/* eslint-disable class-methods-use-this -- the File mock mirrors the instance-only native File surface. */
/* eslint-disable max-lines -- one owned suite covers the upload contract: the presign, the cancelled branch, and the inactivity window that bounds the transfer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trpcClient } from '@/lib/trpc';
import { classifyUploadFailure } from './agent-attachment-types';
import { setUploadForegroundSource } from './upload-foreground';
import { AGENT_ATTACHMENT_UPLOAD_STALL_MS, uploadOne } from './upload-task';
import { classifyAttachment } from './validate';

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentUploadUrl: { mutate: vi.fn() },
      releasePendingUploads: { mutate: vi.fn() },
    },
    organizations: {
      cloudAgentNext: {
        getAttachmentUploadUrl: { mutate: vi.fn() },
        releasePendingUploads: { mutate: vi.fn() },
      },
    },
  },
}));

/** The progress shape the native task really emits: iOS sends `bigint` counts. */
type NativeUploadProgress = { bytesSent: number | bigint; totalBytes: number | bigint };
type UploadTaskOptions = { onProgress?: (progress: NativeUploadProgress) => void };

/** The fake native task a test drives: its transfer and its cancel handle. */
type FakeUploadTask = { uploadAsync: () => Promise<unknown>; cancel: () => void };

/** The native transfer each test gets; a stall test replaces it with a pending one. */
let uploadAsyncImpl: () => Promise<unknown> = () =>
  Promise.resolve({ status: 200, body: '', headers: {} });

const createUploadTaskMock = vi.fn((_url: string, _options: UploadTaskOptions): FakeUploadTask => ({
  uploadAsync: vi.fn(() => uploadAsyncImpl()),
  cancel: vi.fn<() => void>(),
}));
vi.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 'binary-content', MULTIPART: 'multipart' },
  File: class {
    createUploadTask = (url: string, options: UploadTaskOptions): FakeUploadTask =>
      createUploadTaskMock(url, options);
  },
}));

/** The single fake native task the last `uploadOne` call created. */
function createdTask(): FakeUploadTask {
  const task = createUploadTaskMock.mock.results[0]?.value;
  if (!task) {
    throw new Error('no upload task was created');
  }
  return task;
}

/** Awaits `promise` and answers its rejection, so a test never races a handler. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('uploadOne', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uploadAsyncImpl = () => Promise.resolve({ status: 200, body: '', headers: {} });
    vi.mocked(trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate).mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'key.bin',
      expiresAt: new Date().toISOString(),
    });
    vi.mocked(trpcClient.cloudAgentNext.releasePendingUploads.mutate).mockResolvedValue({
      success: true,
    });
    vi.mocked(
      trpcClient.organizations.cloudAgentNext.releasePendingUploads.mutate
    ).mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the classified extension to the presign (invalid-suffix filename → bin)', async () => {
    const classified = classifyAttachment({ name: 'report.v-2', size: 100 });
    expect(classified.ok).toBe(true);
    if (!classified.ok) {
      return;
    }
    expect(classified.extension).toBe('bin');

    await uploadOne({
      attachmentId: 'att-1',
      path: 'path-1',
      extension: classified.extension,
      contentType: 'application/octet-stream',
      contentLength: 100,
      localUri: 'file:///cache/report.v-2.bin',
      onProgress: () => undefined,
    });

    const mutate = vi.mocked(trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        messageUuid: 'path-1',
        attachmentId: 'att-1',
        contentType: 'application/octet-stream',
        contentLength: 100,
        extension: 'bin',
      })
    );
  });

  it('sends extension: "bin" for a suffix longer than 16 characters', async () => {
    const classified = classifyAttachment({
      name: `archive.${'a'.repeat(32)}`,
      size: 100,
    });
    expect(classified.ok).toBe(true);
    if (!classified.ok) {
      return;
    }
    expect(classified.extension).toBe('bin');

    await uploadOne({
      attachmentId: 'att-2',
      path: 'path-2',
      extension: classified.extension,
      contentType: 'application/octet-stream',
      contentLength: 100,
      localUri: 'file:///cache/archive.bin',
      onProgress: () => undefined,
    });

    const mutate = vi.mocked(trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ extension: 'bin' }));
  });

  it('does not create an upload task when cancelled after the presign', async () => {
    await expect(
      uploadOne({
        attachmentId: 'att-3',
        path: 'path-3',
        extension: 'pdf',
        contentType: 'application/pdf',
        contentLength: 100,
        localUri: 'file:///cache/doc.pdf',
        onProgress: () => undefined,
        isCancelled: () => true,
      })
    ).rejects.toThrow('Upload cancelled');

    expect(createUploadTaskMock).not.toHaveBeenCalled();
  });

  it('reports a numeric fraction when iOS sends the byte counts as bigint', async () => {
    const reported: (number | null)[] = [];
    await uploadOne({
      attachmentId: 'att-4',
      path: 'path-4',
      extension: 'jpg',
      contentType: 'image/jpeg',
      contentLength: 1024,
      localUri: 'file:///cache/photo.jpg',
      onProgress: progress => {
        reported.push(progress);
      },
    });

    const emit = createUploadTaskMock.mock.calls[0]?.[1].onProgress;
    emit?.({ bytesSent: 256n, totalBytes: 1024n });
    emit?.({ bytesSent: 1024n, totalBytes: 1024n });
    emit?.({ bytesSent: 10n, totalBytes: 0n });

    expect(reported).toEqual([0.25, 1, null]);
  });

  it('releases the admitted key when a cancel lands during the presign', async () => {
    await expect(
      uploadOne({
        attachmentId: 'att-5',
        path: 'path-5',
        extension: 'pdf',
        contentType: 'application/pdf',
        contentLength: 100,
        localUri: 'file:///cache/cancelled.pdf',
        onProgress: () => undefined,
        isCancelled: () => true,
      })
    ).rejects.toThrow('Upload cancelled');

    const release = vi.mocked(trpcClient.cloudAgentNext.releasePendingUploads.mutate);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ objectKeys: ['key.bin'] });
    expect(createUploadTaskMock).not.toHaveBeenCalled();
  });

  it('releases the admitted key through the organization mutation for an organization upload', async () => {
    vi.mocked(
      trpcClient.organizations.cloudAgentNext.getAttachmentUploadUrl.mutate
    ).mockResolvedValue({
      signedUrl: 'https://r2.example.com/org-signed',
      key: 'org/2026/08/uuid/doc.pdf',
      expiresAt: new Date().toISOString(),
    });

    await expect(
      uploadOne({
        organizationId: 'org-1',
        attachmentId: 'att-6',
        path: 'path-6',
        extension: 'pdf',
        contentType: 'application/pdf',
        contentLength: 100,
        localUri: 'file:///cache/org.pdf',
        onProgress: () => undefined,
        isCancelled: () => true,
      })
    ).rejects.toThrow('Upload cancelled');

    const release = vi.mocked(trpcClient.organizations.cloudAgentNext.releasePendingUploads.mutate);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({
      organizationId: 'org-1',
      objectKeys: ['org/2026/08/uuid/doc.pdf'],
    });
    expect(trpcClient.cloudAgentNext.releasePendingUploads.mutate).not.toHaveBeenCalled();
  });

  it('still rejects with "Upload cancelled" when the release itself fails', async () => {
    vi.mocked(trpcClient.cloudAgentNext.releasePendingUploads.mutate).mockRejectedValue(
      new Error('release unavailable')
    );

    await expect(
      uploadOne({
        attachmentId: 'att-7',
        path: 'path-7',
        extension: 'pdf',
        contentType: 'application/pdf',
        contentLength: 100,
        localUri: 'file:///cache/release-fails.pdf',
        onProgress: () => undefined,
        isCancelled: () => true,
      })
    ).rejects.toThrow('Upload cancelled');
  });

  it('settles a stalled upload as "Upload stalled", cancels the native request, and stays retryable', async () => {
    vi.useFakeTimers();
    uploadAsyncImpl = () => new Promise(() => undefined);

    const pending = uploadOne({
      attachmentId: 'att-8',
      path: 'path-8',
      extension: 'pdf',
      contentType: 'application/pdf',
      contentLength: 100,
      localUri: 'file:///cache/stalled.pdf',
      onProgress: () => undefined,
    });
    const error = rejectionOf(pending);

    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS);

    expect(await error).toEqual(new Error('Upload stalled'));
    expect(createdTask().cancel).toHaveBeenCalledTimes(1);
    expect(classifyUploadFailure(await error)).toEqual({
      retryable: true,
      reason: expect.any(String),
    });
  });

  it('re-arms the stall window on every progress event', async () => {
    vi.useFakeTimers();
    uploadAsyncImpl = () => new Promise(() => undefined);

    const pending = uploadOne({
      attachmentId: 'att-9',
      path: 'path-9',
      extension: 'pdf',
      contentType: 'application/pdf',
      contentLength: 100,
      localUri: 'file:///cache/progressing.pdf',
      onProgress: () => undefined,
    });
    let settled = false;
    const outcome = (async () => {
      const error = await rejectionOf(pending);
      settled = true;
      return error;
    })();

    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS - 1);
    const emit = createUploadTaskMock.mock.calls[0]?.[1].onProgress;
    emit?.({ bytesSent: 40, totalBytes: 100 });
    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS - 1);

    // Both windows ran out short of the limit, so the transfer is still live.
    expect(settled).toBe(false);
    expect(createdTask().cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS);

    expect(await outcome).toEqual(new Error('Upload stalled'));
    expect(createdTask().cancel).toHaveBeenCalledTimes(1);
  });

  it('does not judge an upload for time the app spent in the background', async () => {
    // An iOS transfer keeps moving in a background URLSession while the app is
    // suspended, and JavaScript timers do not run there. The window must not
    // spend the suspended time against the transfer, or a returning app cancels
    // an upload that never stalled.
    vi.useFakeTimers();
    const listeners = new Set<(state: string) => void>();
    setUploadForegroundSource({
      addEventListener: (_type, handler) => {
        listeners.add(handler);
        return {
          remove: () => {
            listeners.delete(handler);
          },
        };
      },
    });
    const sendState = (state: string) => {
      for (const handler of listeners) {
        handler(state);
      }
    };
    uploadAsyncImpl = () => new Promise(() => undefined);

    const pending = uploadOne({
      attachmentId: 'att-10',
      path: 'path-10',
      extension: 'pdf',
      contentType: 'application/pdf',
      contentLength: 100,
      localUri: 'file:///cache/backgrounded.pdf',
      onProgress: () => undefined,
    });
    let settled = false;
    const outcome = (async () => {
      const error = await rejectionOf(pending);
      settled = true;
      return error;
    })();

    // The window is built after the presign resolves, so let that land first,
    // otherwise the state change reaches no listener.
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners.size).toBe(1);
    sendState('background');
    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS * 3);

    // Three windows of suspended time must not be held against the transfer.
    expect(settled).toBe(false);
    expect(createdTask().cancel).not.toHaveBeenCalled();

    // Back in front, it gets a whole fresh window before it counts as stalled.
    sendState('active');
    await vi.advanceTimersByTimeAsync(AGENT_ATTACHMENT_UPLOAD_STALL_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(new Error('Upload stalled'));
    setUploadForegroundSource({ addEventListener: () => ({ remove: () => undefined }) });
  });
});
