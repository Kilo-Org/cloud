/* eslint-disable max-lines -- cohesive suite: the materialization, viewer, and account-fence cases share one mock harness */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ShareRemoteFileModule from '@/lib/share-remote-file';

import {
  getDocumentPreviewTarget,
  previewLocalDocument,
  previewRemoteDocument,
} from './document-preview';

type FileInstance = {
  uri: string;
  exists: boolean;
  canPreview: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const fileSystem = vi.hoisted(() => {
  const behavior = {
    canPreview: true,
    previewError: null as Error | null,
    canPreviewError: null as Error | null,
    exists: true,
  };
  const instances: {
    uri: string;
    exists: boolean;
    canPreview: ReturnType<typeof vi.fn>;
    preview: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    copy: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  }[] = [];
  const directoryCreate = vi.fn();
  const Directory = vi.fn(function DirectoryMock() {
    return { create: directoryCreate };
  });
  const File = vi.fn(function FileMock(directoryOrUri: unknown, filename?: string) {
    const uri =
      typeof directoryOrUri === 'string'
        ? directoryOrUri
        : `file:///cache/session-file-parts/${filename ?? ''}`;
    const instance = {
      uri,
      get exists() {
        return behavior.exists;
      },
      get extension() {
        const dot = uri.lastIndexOf('.');
        return dot === -1 ? '' : uri.slice(dot);
      },
      canPreview: vi.fn(() => {
        if (behavior.canPreviewError !== null) {
          return Promise.reject(behavior.canPreviewError);
        }
        return Promise.resolve(behavior.canPreview);
      }),
      preview: vi.fn(() =>
        behavior.previewError !== null ? Promise.reject(behavior.previewError) : Promise.resolve()
      ),
      write: vi.fn(() => Promise.resolve()),
      copy: vi.fn(() => Promise.resolve()),
      delete: vi.fn(),
    };
    instances.push(instance as unknown as (typeof instances)[number]);
    return instance;
  });
  return {
    behavior,
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    directoryCreate,
    instances,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: fileSystem.Directory,
  File: fileSystem.File,
  Paths: fileSystem.Paths,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const downloadRemoteFile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/share-remote-file', async importOriginal => {
  const actual = await importOriginal<typeof ShareRemoteFileModule>();
  return {
    ...actual,
    downloadRemoteFile,
  };
});

const registerTempFile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/temp-file-registry', () => ({ registerTempFile }));

const authEpoch = vi.hoisted(() => ({ value: 0 }));

vi.mock('@/lib/auth/auth-epoch', () => ({
  currentAuthEpoch: () => authEpoch.value,
  isCurrentAuthEpoch: (epoch: number) => epoch === authEpoch.value,
  bumpAuthEpoch: () => {
    authEpoch.value += 1;
  },
}));

function filesFor(uri: string): FileInstance[] {
  return fileSystem.instances.filter(instance => instance.uri === uri) as FileInstance[];
}

function ownedCopy(uri: string) {
  const deleteFile = vi.fn();
  return { uri, delete: deleteFile, deleteFile } as const;
}

beforeEach(() => {
  fileSystem.instances.length = 0;
  fileSystem.directoryCreate.mockClear();
  fileSystem.behavior.canPreview = true;
  fileSystem.behavior.previewError = null;
  fileSystem.behavior.canPreviewError = null;
  fileSystem.behavior.exists = true;
  downloadRemoteFile.mockReset();
  registerTempFile.mockReset();
  authEpoch.value = 0;
});

describe('getDocumentPreviewTarget', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['application/docx-impostor', undefined],
    ['application/msword', 'doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['application/vnd.oasis.opendocument.presentation', 'odp'],
    ['application/epub+zip', 'epub'],
  ])('maps %s to %s', (mime, extension) => {
    const target = getDocumentPreviewTarget(mime);
    if (extension === undefined) {
      expect(target).toBeNull();
      return;
    }
    expect(target).toEqual({ mimeType: mime, extension });
  });

  it('normalizes case and drops MIME parameters before matching', () => {
    expect(getDocumentPreviewTarget(' Application/PDF; charset=binary ')).toEqual({
      mimeType: 'application/pdf',
      extension: 'pdf',
    });
  });

  it.each([
    'text/plain',
    'text/markdown',
    'image/png',
    'video/mp4',
    'application/octet-stream',
    'application/zip',
    '',
    undefined,
  ])('leaves %s on its text and share choices', mime => {
    expect(getDocumentPreviewTarget(mime)).toBeNull();
  });
});

describe('previewRemoteDocument', () => {
  it('writes a data URL under the canonical extension and hands the known MIME to the viewer', async () => {
    const outcome = await previewRemoteDocument({
      key: 'part-1',
      url: 'data:application/pdf;base64,QUJD',
      mimeType: 'application/pdf',
      filename: 'report',
    });

    expect(outcome).toBe('opened');
    expect(fileSystem.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    const [written, presented] = filesFor('file:///cache/session-file-parts/part-1-report.pdf');
    expect(written?.write).toHaveBeenCalledWith('QUJD', { encoding: 'base64' });
    expect(presented?.canPreview).toHaveBeenCalledWith({ mimeType: 'application/pdf' });
    expect(presented?.preview).toHaveBeenCalledWith({
      mimeType: 'application/pdf',
      title: 'report',
    });
    expect(registerTempFile).toHaveBeenCalledWith(
      'file:///cache/session-file-parts/part-1-report.pdf'
    );
  });

  it('replaces a misleading extension on the preview copy with the MIME extension', async () => {
    await previewRemoteDocument({
      key: 'part-2',
      url: 'data:application/pdf;base64,QUJD',
      mimeType: 'application/pdf',
      filename: 'quarterly.tmp',
    });

    expect(
      filesFor('file:///cache/session-file-parts/part-2-quarterly.pdf').length
    ).toBeGreaterThan(0);
    expect(filesFor('file:///cache/session-file-parts/part-2-quarterly.tmp')).toHaveLength(0);
  });

  it('downloads a signed URL and keeps the copy for the TTL reap', async () => {
    const copy = ownedCopy('file:///cache/session-file-parts/part-3-report.pdf');
    downloadRemoteFile.mockResolvedValue(copy);

    const outcome = await previewRemoteDocument({
      key: 'part-3',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('opened');
    expect(downloadRemoteFile).toHaveBeenCalledWith({
      url: 'https://r2.example.com/report.pdf',
      cacheDirectoryName: 'session-file-parts',
      cacheFilename: 'part-3-report.pdf',
    });
    expect(copy.deleteFile).not.toHaveBeenCalled();
    expect(registerTempFile).toHaveBeenCalledWith(copy.uri);
  });

  it('presents a local sandbox file without copying or registering it', async () => {
    const outcome = await previewRemoteDocument({
      key: 'part-4',
      url: 'file:///tmp/attachments/session/user/message/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('opened');
    expect(downloadRemoteFile).not.toHaveBeenCalled();
    expect(registerTempFile).not.toHaveBeenCalled();
    const [file] = filesFor('file:///tmp/attachments/session/user/message/report.pdf');
    expect(file?.preview).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable, drops the copy, and never presents when no viewer handles the type', async () => {
    fileSystem.behavior.canPreview = false;
    const copy = ownedCopy('file:///cache/session-file-parts/part-5-report.pdf');
    downloadRemoteFile.mockResolvedValue(copy);

    const outcome = await previewRemoteDocument({
      key: 'part-5',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('unavailable');
    expect(copy.deleteFile).toHaveBeenCalledTimes(1);
    expect(registerTempFile).not.toHaveBeenCalled();
    expect(filesFor(copy.uri)[0]?.preview).not.toHaveBeenCalled();
  });

  it('reports a failed open when the viewer rejects the presentation', async () => {
    fileSystem.behavior.previewError = new Error('File preview is already in progress');
    const copy = ownedCopy('file:///cache/session-file-parts/part-6-report.pdf');
    downloadRemoteFile.mockResolvedValue(copy);

    const outcome = await previewRemoteDocument({
      key: 'part-6',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('failed');
    expect(copy.deleteFile).toHaveBeenCalledTimes(1);
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('reports a failed open when the download fails', async () => {
    downloadRemoteFile.mockRejectedValue(new Error('download-failed'));

    const outcome = await previewRemoteDocument({
      key: 'part-7',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('failed');
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('reports a failed open instead of throwing on an unreadable uri', async () => {
    fileSystem.File.mockImplementationOnce(function FileUnreadable() {
      throw new Error('invalid uri');
    });

    const outcome = await previewRemoteDocument({
      key: 'part-16',
      url: 'file:///cache/session-file-parts/broken',
      mimeType: 'application/pdf',
      filename: 'broken.pdf',
    });

    expect(outcome).toBe('failed');
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('presents a cache copy under the canonical extension when the name has none', async () => {
    const outcome = await previewRemoteDocument({
      key: 'part-13',
      url: 'file:///cache/session-file-parts/part-13-summary',
      mimeType: 'application/pdf',
      filename: 'summary',
    });

    expect(outcome).toBe('opened');
    const source = filesFor('file:///cache/session-file-parts/part-13-summary')[0];
    const presented = filesFor('file:///cache/session-file-parts/part-13-summary.pdf')[0];
    expect(source?.copy).toHaveBeenCalledWith(presented, { overwrite: true });
    expect(source?.preview).not.toHaveBeenCalled();
    expect(source?.delete).not.toHaveBeenCalled();
    expect(presented?.canPreview).toHaveBeenCalledWith({ mimeType: 'application/pdf' });
    expect(registerTempFile).toHaveBeenCalledWith(
      'file:///cache/session-file-parts/part-13-summary.pdf'
    );
  });

  it('deletes the canonical copy and skips the viewer when the platform cannot present it', async () => {
    fileSystem.behavior.canPreview = false;

    const outcome = await previewRemoteDocument({
      key: 'part-14',
      url: 'file:///cache/session-file-parts/part-14-summary.tmp',
      mimeType: 'application/pdf',
      filename: 'summary.tmp',
    });

    expect(outcome).toBe('unavailable');
    const presented = filesFor('file:///cache/session-file-parts/part-14-summary.pdf')[0];
    expect(presented?.delete).toHaveBeenCalledTimes(1);
    expect(presented?.preview).not.toHaveBeenCalled();
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('reports a failed open when the canonical copy cannot be written', async () => {
    fileSystem.File.mockImplementationOnce(function FileCopyFails() {
      return {
        uri: 'file:///cache/session-file-parts/part-15-summary',
        exists: true,
        extension: '',
        canPreview: vi.fn(),
        preview: vi.fn(),
        write: vi.fn(),
        copy: vi.fn(() => Promise.reject(new Error('copy-failed'))),
        delete: vi.fn(),
      };
    });

    const outcome = await previewRemoteDocument({
      key: 'part-15',
      url: 'file:///cache/session-file-parts/part-15-summary',
      mimeType: 'application/pdf',
      filename: 'summary',
    });

    expect(outcome).toBe('failed');
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('reports a failed open for a copy that does not exist', async () => {
    fileSystem.behavior.exists = false;

    const outcome = await previewRemoteDocument({
      key: 'part-8',
      url: 'file:///tmp/attachments/session/user/message/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('failed');
    expect(
      filesFor('file:///tmp/attachments/session/user/message/report.pdf')[0]?.preview
    ).not.toHaveBeenCalled();
  });

  it('never downloads an unsupported type', async () => {
    const outcome = await previewRemoteDocument({
      key: 'part-9',
      url: 'https://r2.example.com/bundle.zip',
      mimeType: 'application/zip',
      filename: 'bundle.zip',
    });

    expect(outcome).toBe('unavailable');
    expect(downloadRemoteFile).not.toHaveBeenCalled();
  });

  it('drops the copy and skips the viewer when the account changes during the download', async () => {
    const copy = ownedCopy('file:///cache/session-file-parts/part-10-report.pdf');
    downloadRemoteFile.mockImplementation(() => {
      authEpoch.value += 1;
      return Promise.resolve(copy);
    });

    const outcome = await previewRemoteDocument({
      key: 'part-10',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('account-changed');
    expect(copy.deleteFile).toHaveBeenCalledTimes(1);
    expect(fileSystem.instances).toHaveLength(0);
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('drops the copy and skips the viewer when the account changes during the preview check', async () => {
    const copy = ownedCopy('file:///cache/session-file-parts/part-11-report.pdf');
    downloadRemoteFile.mockResolvedValue(copy);

    fileSystem.File.mockImplementationOnce(function FileAccountChange() {
      return {
        uri: copy.uri,
        exists: true,
        extension: '.pdf',
        canPreview: vi.fn(() => {
          authEpoch.value += 1;
          return Promise.resolve(true);
        }),
        preview: vi.fn(),
        write: vi.fn(),
        copy: vi.fn(),
        delete: vi.fn(),
      };
    });

    const outcome = await previewRemoteDocument({
      key: 'part-11',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('account-changed');
    expect(copy.deleteFile).toHaveBeenCalledTimes(1);
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('ignores a repeated tap while the first preview is materializing', async () => {
    const pending = Promise.withResolvers<{ uri: string; delete: () => void }>();
    downloadRemoteFile.mockReturnValue(pending.promise);

    const first = previewRemoteDocument({
      key: 'part-12',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });
    const second = await previewRemoteDocument({
      key: 'part-12',
      url: 'https://r2.example.com/report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(second).toBe('busy');
    expect(downloadRemoteFile).toHaveBeenCalledTimes(1);

    const copy = ownedCopy('file:///cache/session-file-parts/part-12-report.pdf');
    pending.resolve(copy);
    expect(await first).toBe('opened');
    expect(downloadRemoteFile).toHaveBeenCalledTimes(1);
  });
});

describe('previewLocalDocument', () => {
  it('presents the composer copy and never deletes it', async () => {
    const outcome = await previewLocalDocument({
      key: 'chip-1',
      uri: 'file:///cache/local-picker/chip-1-report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('opened');
    const [file] = filesFor('file:///cache/local-picker/chip-1-report.pdf');
    expect(file?.canPreview).toHaveBeenCalledWith({ mimeType: 'application/pdf' });
    expect(file?.preview).toHaveBeenCalledWith({
      mimeType: 'application/pdf',
      title: 'report.pdf',
    });
    expect(file?.delete).not.toHaveBeenCalled();
    expect(registerTempFile).not.toHaveBeenCalled();
  });

  it('reports unavailable and keeps the chip file when the device has no viewer', async () => {
    fileSystem.behavior.canPreview = false;

    const outcome = await previewLocalDocument({
      key: 'chip-2',
      uri: 'file:///cache/local-picker/chip-2-report.pdf',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(outcome).toBe('unavailable');
    expect(
      filesFor('file:///cache/local-picker/chip-2-report.pdf')[0]?.delete
    ).not.toHaveBeenCalled();
  });

  it('reports unavailable for a text attachment without touching the file', async () => {
    const outcome = await previewLocalDocument({
      key: 'chip-3',
      uri: 'file:///cache/local-picker/chip-3-notes.txt',
      mimeType: 'text/plain',
      filename: 'notes.txt',
    });

    expect(outcome).toBe('unavailable');
    expect(filesFor('file:///cache/local-picker/chip-3-notes.txt')).toHaveLength(0);
  });
});
