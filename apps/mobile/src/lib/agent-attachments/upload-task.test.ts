/* eslint-disable class-methods-use-this -- the File mock mirrors the instance-only native File surface. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { trpcClient } from '@/lib/trpc';
import { classifyAttachment } from './validate';
import { uploadOne } from './upload-task';

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentUploadUrl: { mutate: vi.fn() },
    },
    organizations: {
      cloudAgentNext: {
        getAttachmentUploadUrl: { mutate: vi.fn() },
      },
    },
  },
}));

/** The progress shape the native task really emits: iOS sends `bigint` counts. */
type NativeUploadProgress = { bytesSent: number | bigint; totalBytes: number | bigint };
type UploadTaskOptions = { onProgress?: (progress: NativeUploadProgress) => void };

const createUploadTaskMock = vi.fn((_url: string, _options: UploadTaskOptions) => ({
  uploadAsync: vi.fn().mockResolvedValue({ status: 200, body: '', headers: {} }),
  cancel: vi.fn(),
}));
vi.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 'binary-content', MULTIPART: 'multipart' },
  File: class {
    createUploadTask = (url: string, options: UploadTaskOptions): unknown =>
      createUploadTaskMock(url, options);
  },
}));

describe('uploadOne', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(trpcClient.cloudAgentNext.getAttachmentUploadUrl.mutate).mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'key.bin',
      expiresAt: new Date().toISOString(),
    });
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
});
