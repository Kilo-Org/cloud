import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadRemoteFile,
  getSafeCacheFilename,
  shareLocalFile,
  shareMaterializedRemoteFile,
  shareRemoteFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';
import { utf8ByteLength } from '@/lib/utf8-utils';

const expoFileSystemMock = vi.hoisted(() => {
  const Directory = vi.fn(function DirectoryMock(base: string, name: string) {
    return {
      uri: `${base}/${name}`,
      create: vi.fn(),
    };
  });
  const File = vi.fn(function FileMock(base: { uri: string }, name: string) {
    return {
      uri: `${base.uri}/${name}`,
      delete: vi.fn(),
    };
  });
  return {
    Directory,
    File: Object.assign(File, { downloadFileAsync: vi.fn() }),
    Paths: { cache: 'file:///cache' },
  };
});

const expoSharingMock = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const tempFileRegistryMock = vi.hoisted(() => ({
  registerTempFile: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: expoSharingMock.isAvailableAsync,
  shareAsync: expoSharingMock.shareAsync,
}));

vi.mock('@/lib/temp-file-registry', () => ({
  registerTempFile: tempFileRegistryMock.registerTempFile,
}));

beforeEach(() => {
  vi.clearAllMocks();
  expoSharingMock.isAvailableAsync.mockResolvedValue(true);
  expoSharingMock.shareAsync.mockResolvedValue(undefined);
});

describe('getSafeCacheFilename', () => {
  it('bounds cache filenames and preserves the extension', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const filename = `${'a'.repeat(508)}.pdf`;
    const cacheFilename = getSafeCacheFilename({ id, filename });

    expect(utf8ByteLength(cacheFilename)).toBeLessThanOrEqual(255);
    expect(cacheFilename.startsWith(`${id}-`)).toBe(true);
    expect(cacheFilename.endsWith('.pdf')).toBe(true);
  });

  it('sanitizes unsafe path characters', () => {
    expect(getSafeCacheFilename({ id: 'inv/1', filename: 'a b.pdf' })).toBe('inv_1-a_b.pdf');
  });
});

describe('shareLocalFile', () => {
  it('throws sharing-unavailable when the platform cannot share', async () => {
    expoSharingMock.isAvailableAsync.mockResolvedValue(false);

    await expect(shareLocalFile('file:///tmp/a.pdf')).rejects.toMatchObject({
      reason: 'sharing-unavailable',
    });
    expect(expoSharingMock.shareAsync).not.toHaveBeenCalled();
  });

  it('presents the native share sheet when sharing is available', async () => {
    await shareLocalFile('file:///tmp/a.pdf');
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/a.pdf', undefined);
  });

  it('passes mimeType to shareAsync when provided', async () => {
    await shareLocalFile('file:///tmp/a.pdf', { mimeType: 'application/pdf' });
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/a.pdf', {
      mimeType: 'application/pdf',
    });
  });

  it('does not pass mimeType when omitted', async () => {
    await shareLocalFile('file:///tmp/b.png');
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith('file:///tmp/b.png', undefined);
  });
});

describe('shareMaterializedRemoteFile', () => {
  it('keeps the temp file for the TTL reap after a successful share', async () => {
    const deleted: string[] = [];
    await shareMaterializedRemoteFile(
      {
        uri: 'file:///cache/org-invoices/a.pdf',
        delete: () => {
          deleted.push('file:///cache/org-invoices/a.pdf');
        },
      },
      async () => {
        await Promise.resolve();
      }
    );
    expect(deleted).toEqual([]);
    expect(tempFileRegistryMock.registerTempFile).toHaveBeenCalledWith(
      'file:///cache/org-invoices/a.pdf'
    );
  });

  it('deletes the temp file after share failures', async () => {
    const deleted: string[] = [];
    await expect(
      shareMaterializedRemoteFile(
        {
          uri: 'file:///cache/org-invoices/a.pdf',
          delete: () => {
            deleted.push('file:///cache/org-invoices/a.pdf');
          },
        },
        async () => {
          await Promise.resolve();
          throw new Error('share failed');
        }
      )
    ).rejects.toThrow('share failed');
    expect(deleted).toEqual(['file:///cache/org-invoices/a.pdf']);
    expect(tempFileRegistryMock.registerTempFile).not.toHaveBeenCalled();
  });
});

describe('downloadRemoteFile', () => {
  it('downloads an http(s) URL and returns a materialized file with a working delete', async () => {
    const downloaded = {
      uri: 'file:///cache/org-invoices/in_1-a.pdf',
      delete: vi.fn(),
    };
    expoFileSystemMock.File.downloadFileAsync.mockResolvedValue(downloaded);

    const result = await downloadRemoteFile({
      url: 'https://example.com/a.pdf',
      cacheDirectoryName: 'org-invoices',
      cacheFilename: 'in_1-a.pdf',
    });

    expect(result.uri).toBe('file:///cache/org-invoices/in_1-a.pdf');
    expect(expoFileSystemMock.File.downloadFileAsync).toHaveBeenCalledWith(
      'https://example.com/a.pdf',
      expect.objectContaining({ uri: 'file:///cache/org-invoices/in_1-a.pdf' }),
      { idempotent: true }
    );

    result.delete();
    expect(downloaded.delete).toHaveBeenCalled();
  });
});

describe('shareRemoteFile', () => {
  it('throws download-failed when materialization fails', async () => {
    expoFileSystemMock.File.downloadFileAsync.mockRejectedValue(new Error('network down'));

    await expect(
      shareRemoteFile({
        url: 'https://example.com/a.pdf',
        cacheDirectoryName: 'org-invoices',
        cacheKey: 'in_1',
        filename: 'a.pdf',
      })
    ).rejects.toBeInstanceOf(ShareRemoteFileError);

    await expect(
      shareRemoteFile({
        url: 'https://example.com/a.pdf',
        cacheDirectoryName: 'org-invoices',
        cacheKey: 'in_1',
        filename: 'a.pdf',
      })
    ).rejects.toMatchObject({ reason: 'download-failed' });
  });

  it('downloads then shares a remote file', async () => {
    const downloaded = {
      uri: 'file:///cache/org-invoices/in_1-a.pdf',
      delete: vi.fn(),
    };
    expoFileSystemMock.File.downloadFileAsync.mockResolvedValue(downloaded);

    await shareRemoteFile({
      url: 'https://example.com/a.pdf',
      cacheDirectoryName: 'org-invoices',
      cacheKey: 'in_1',
      filename: 'a.pdf',
    });

    expect(expoFileSystemMock.File.downloadFileAsync).toHaveBeenCalledWith(
      'https://example.com/a.pdf',
      expect.objectContaining({ uri: 'file:///cache/org-invoices/in_1-a.pdf' }),
      { idempotent: true }
    );
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith(downloaded.uri, undefined);
    expect(downloaded.delete).not.toHaveBeenCalled();
    expect(tempFileRegistryMock.registerTempFile).toHaveBeenCalledWith(downloaded.uri);
  });
});
