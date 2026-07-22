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

vi.mock('expo-file-system/legacy', () => ({
  createUploadTask: vi.fn(() => ({
    uploadAsync: vi.fn().mockResolvedValue({ status: 200 }),
  })),
  FileSystemUploadType: { BINARY_CONTENT: 'binary-content' },
  getInfoAsync: vi.fn().mockResolvedValue({
    exists: true,
    isDirectory: false,
    size: 100,
  }),
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
});
