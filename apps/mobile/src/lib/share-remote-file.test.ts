import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getSafeCacheFilename,
  shareLocalFile,
  shareMaterializedRemoteFile,
  shareRemoteFile,
  ShareRemoteFileError,
} from '@/lib/share-remote-file';

const expoFileSystemMock = vi.hoisted(() => {
  const File = vi.fn(function FileMock() {
    return {};
  });
  const Directory = vi.fn(function DirectoryMock() {
    return {
      create: vi.fn(),
    };
  });
  return {
    Directory,
    File: Object.assign(File, { downloadFileAsync: vi.fn() }),
    Paths: { cache: 'file:///cache' },
  };
});

const reactNativeMock = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
}));

const expoSharingMock = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

vi.mock('react-native', () => ({
  Platform: reactNativeMock.Platform,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: expoSharingMock.isAvailableAsync,
  shareAsync: expoSharingMock.shareAsync,
}));

beforeEach(() => {
  vi.clearAllMocks();
  reactNativeMock.Platform.OS = 'ios';
  expoSharingMock.isAvailableAsync.mockResolvedValue(true);
  expoSharingMock.shareAsync.mockResolvedValue(undefined);
});

describe('getSafeCacheFilename', () => {
  it('bounds cache filenames and preserves the extension', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const filename = `${'a'.repeat(508)}.pdf`;
    const cacheFilename = getSafeCacheFilename({ id, filename });

    expect(new TextEncoder().encode(cacheFilename).byteLength).toBeLessThanOrEqual(255);
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
  it('deletes the temp file after a successful iOS share', async () => {
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
    expect(deleted).toEqual(['file:///cache/org-invoices/a.pdf']);
  });

  it('keeps the temp file after a successful Android share', async () => {
    reactNativeMock.Platform.OS = 'android';
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

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith('file:///cache', 'org-invoices');
    expect(expoFileSystemMock.File.downloadFileAsync).toHaveBeenCalled();
    expect(expoSharingMock.shareAsync).toHaveBeenCalledWith(downloaded.uri, undefined);
    expect(downloaded.delete).toHaveBeenCalled();
  });
});
