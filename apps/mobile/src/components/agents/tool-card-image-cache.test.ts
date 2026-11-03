/* eslint-disable max-lines -- cohesive unit suite for the tool attachment cache: naming, dedupe, write lifetime, reset fencing, and hook subscription paths share one mock harness */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetToolCardImageCacheForTests,
  cacheToolAttachment,
  cacheToolCardImage,
  clearToolCardImageCache,
  extensionForImageMime,
  extensionForMime,
  getToolCardImageUri,
  isToolCardImagePending,
  stripDataUrlBase64Prefix,
  useToolCardImageUri,
} from '@/components/agents/tool-card-image-cache';

type FileInstance = {
  exists: boolean;
  uri: string;
  written?: { content: string; encoding?: string };
  write: (content: string, options?: { encoding?: string }) => Promise<void>;
  directory?: { name?: string };
  filename: string;
};

const fileInstances: FileInstance[] = [];

const expoFileSystemMock = vi.hoisted(() => {
  const directoryCreate = vi.fn();
  const directoryDelete = vi.fn();
  const Directory = vi.fn(function DirectoryMock(_base: unknown, name: string) {
    return {
      name,
      create: directoryCreate,
      exists: true,
      delete: directoryDelete,
    };
  });
  const File = vi.fn(function FileMock(directory: { name?: string }, filename: string) {
    const instance: FileInstance = {
      exists: false,
      uri: `file:///cache/tool-card-images/${filename}`,
      write(content, options) {
        this.written = { content, encoding: options?.encoding };
        return Promise.resolve();
      },
      filename,
      directory,
    };
    fileInstances.push(instance);
    return instance;
  });
  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    directoryCreate,
    directoryDelete,
  };
});

vi.mock('expo-file-system', () => ({
  Directory: expoFileSystemMock.Directory,
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

vi.mock('@/lib/share-remote-file', () => ({
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) =>
    `${id}-${filename.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fileInstances.length = 0;
  __resetToolCardImageCacheForTests();
});

/** Drain the fire-and-forget write continuations, for "nothing further landed" checks. */
async function drainCacheWrites(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('extensionForImageMime', () => {
  it('maps png and jpeg, and passes other subtypes through', () => {
    expect(extensionForImageMime('image/png')).toBe('png');
    expect(extensionForImageMime('image/jpeg')).toBe('jpg');
    expect(extensionForImageMime('image/webp')).toBe('webp');
  });
});

describe('extensionForMime', () => {
  it('maps image mimes identically to extensionForImageMime', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
  });

  it('extracts the subtype for non-image mimes', () => {
    expect(extensionForMime('application/pdf')).toBe('pdf');
    expect(extensionForMime('text/plain')).toBe('plain');
    expect(
      extensionForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    ).toBe('vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('falls back to bin for malformed or empty mimes', () => {
    expect(extensionForMime('')).toBe('bin');
    expect(extensionForMime('invalid')).toBe('bin');
    expect(extensionForMime('text/')).toBe('bin');
  });
});

describe('stripDataUrlBase64Prefix', () => {
  it('strips the mime-specific data URL prefix', () => {
    expect(stripDataUrlBase64Prefix('data:image/png;base64,AAA', 'image/png')).toBe('AAA');
    expect(stripDataUrlBase64Prefix('data:image/jpeg;base64,/9j/', 'image/jpeg')).toBe('/9j/');
  });

  it('returns undefined for a non-data URL', () => {
    expect(stripDataUrlBase64Prefix('https://example.com/a.png', 'image/png')).toBeUndefined();
  });
});

describe('cacheToolCardImage', () => {
  it('writes base64 payload under a mime-derived filename and exposes the file URI', async () => {
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,QUJD');

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith('file:///cache', 'tool-card-images');
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    expect(expoFileSystemMock.File).toHaveBeenCalled();
    const file = fileInstances[0];
    expect(file?.filename).toBe('part-1.png');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-1')).toBe('file:///cache/tool-card-images/part-1.png');
    });
    expect(file?.written).toEqual({ content: 'QUJD', encoding: 'base64' });
  });

  it('derives jpg for image/jpeg', () => {
    cacheToolCardImage('part-jpg', 'image/jpeg', 'data:image/jpeg;base64,AAA');
    expect(fileInstances[0]?.filename).toBe('part-jpg.jpg');
  });

  it('does not rewrite when the same part id is cached twice (Set dedupe)', async () => {
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,AAA');
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,BBB');

    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-1')).toBe('file:///cache/tool-card-images/part-1.png');
    });
    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.written).toEqual({ content: 'AAA', encoding: 'base64' });
  });

  it('skips the write when the file already exists and still records the URI', () => {
    // First construct will be the exists-check instance — seed exists=true
    // by making File return an existing file on first construction.
    const write = vi.fn<(content: string) => Promise<void>>(() => Promise.resolve());
    expoFileSystemMock.File.mockImplementationOnce(function FileExists(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: true,
        uri: `file:///cache/tool-card-images/${filename}`,
        write,
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    cacheToolCardImage('part-exists', 'image/png', 'data:image/png;base64,AAA');

    expect(write).not.toHaveBeenCalled();
    expect(getToolCardImageUri('part-exists')).toBe(
      'file:///cache/tool-card-images/part-exists.png'
    );
    // Second call must still be deduped by the Set (no second File).
    cacheToolCardImage('part-exists', 'image/png', 'data:image/png;base64,BBB');
    expect(fileInstances).toHaveLength(1);
  });

  it('clears the dedupe mark and records no URI when the write fails', async () => {
    expoFileSystemMock.File.mockImplementationOnce(function FileFail(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: false,
        uri: `file:///cache/tool-card-images/${filename}`,
        write: vi.fn(() => Promise.reject(new Error('disk full'))),
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    expect(() => {
      cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    }).not.toThrow();

    await drainCacheWrites();
    expect(getToolCardImageUri('part-fail')).toBeUndefined();

    // Failure cleared the mark — a retry is allowed and should attempt again.
    cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-fail')).toBe('file:///cache/tool-card-images/part-fail.png');
    });
    expect(fileInstances).toHaveLength(2);
    expect(fileInstances[1]?.written).toEqual({ content: 'AAA', encoding: 'base64' });
  });

  it('never throws on invalid input', () => {
    expect(() => {
      cacheToolCardImage('part-x', 'image/png', 'not-a-data-url');
    }).not.toThrow();
    expect(fileInstances).toHaveLength(0);
    expect(getToolCardImageUri('part-x')).toBeUndefined();
  });
});

describe('cacheToolAttachment', () => {
  it('writes base64 payload for a pdf attachment with a filename using getSafeCacheFilename', async () => {
    cacheToolAttachment('part-send', {
      mime: 'application/pdf',
      dataUrl: 'data:application/pdf;base64,QUJD',
      filename: 'report.pdf',
    });

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith('file:///cache', 'tool-card-images');
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    const file = fileInstances[0];
    // getSafeCacheFilename({ id: 'part-send', filename: 'report.pdf' })
    //  → 'part-send-report.pdf' (after sanitization)
    expect(file?.filename).toBe('part-send-report.pdf');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-send')).toBe(
        'file:///cache/tool-card-images/part-send-report.pdf'
      );
    });
    expect(file?.written).toEqual({ content: 'QUJD', encoding: 'base64' });
  });

  it('uses extension-based naming when no filename is provided (image fallback)', async () => {
    cacheToolAttachment('part-img', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });

    const file = fileInstances[0];
    expect(file?.filename).toBe('part-img.png');
    await vi.waitFor(() => {
      expect(file?.written).toEqual({ content: 'AAA', encoding: 'base64' });
    });
  });

  it('preserves _DOT_ in the partId, replacing only the appended final -_DOT_ suffix', async () => {
    cacheToolAttachment('part-_DOT_42', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
    });

    const file = fileInstances[0];
    // partId "part-_DOT_42" + filename "_DOT_png" →
    //   mock getSafeCacheFilename → "part-_DOT_42-_DOT_png"
    //   _DOT_ in partId must survive; only final -_DOT_ before ext is replaced →
    //   "part-_DOT_42.png"
    expect(file?.filename).toBe('part-_DOT_42.png');
    await vi.waitFor(() => {
      expect(file?.written).toEqual({ content: 'AAA', encoding: 'base64' });
    });
  });

  it('deduplicates same part id across cacheToolAttachment calls', async () => {
    cacheToolAttachment('part-dup', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
      filename: 'img.png',
    });
    cacheToolAttachment('part-dup', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,BBB',
      filename: 'other.png',
    });

    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-dup')).toBe(
        'file:///cache/tool-card-images/part-dup-img.png'
      );
    });
    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.written).toEqual({ content: 'AAA', encoding: 'base64' });
  });

  it('sanitizes special characters in the MIME subtype when no filename is provided', async () => {
    // The subtype "vnd.<script>alert" contains < and > which are unsafe in
    // filenames.  The safe-cache-filename logic must strip them.
    cacheToolAttachment('part-xss', {
      mime: 'application/vnd.<script>alert',
      dataUrl: 'data:application/vnd.<script>alert;base64,AAA',
    });

    const file = fileInstances[0];
    // getSafeCacheFilename({ id: 'part-xss', filename: 'vnd.<script>alert' })
    // mock sanitizes → 'vnd._script_alert'
    expect(file?.filename).toBe('part-xss.vnd._script_alert');
    await vi.waitFor(() => {
      expect(file?.written).toEqual({ content: 'AAA', encoding: 'base64' });
    });
  });

  it('routes a very long MIME subtype through the safe filename function', async () => {
    const longSubtype = 'x'.repeat(10_000);
    cacheToolAttachment('part-long', {
      mime: `application/${longSubtype}`,
      dataUrl: `data:application/${longSubtype};base64,AAA`,
    });

    const file = fileInstances[0];
    // The mock does not truncate, but the real getSafeCacheFilename bounds
    // to 255 bytes.  This test verifies the code path routes through the safe
    // function instead of raw concatenation.
    expect(file?.filename).toMatch(/^part-long\./);
    await vi.waitFor(() => {
      expect(file?.written).toEqual({ content: 'AAA', encoding: 'base64' });
    });
  });

  it('shares the dedupe set with cacheToolCardImage', async () => {
    cacheToolCardImage('part-shared', 'image/png', 'data:image/png;base64,AAA');
    cacheToolAttachment('part-shared', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,BBB',
      filename: 'name.png',
    });

    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.filename).toBe('part-shared.png');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-shared')).toBe(
        'file:///cache/tool-card-images/part-shared.png'
      );
    });
  });
});

describe('clearToolCardImageCache', () => {
  it('deletes the cache directory and resets in-memory state', async () => {
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,AAA');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-1')).toBe('file:///cache/tool-card-images/part-1.png');
    });

    clearToolCardImageCache();

    expect(expoFileSystemMock.directoryDelete).toHaveBeenCalledTimes(1);
    expect(getToolCardImageUri('part-1')).toBeUndefined();
    // The dedupe set reset, so the same part id can be cached again.
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,BBB');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-1')).toBe('file:///cache/tool-card-images/part-1.png');
    });
    expect(fileInstances).toHaveLength(2);
  });

  it('skips delete when the directory does not exist', () => {
    expoFileSystemMock.Directory.mockImplementationOnce(function DirectoryMissing(
      _base: unknown,
      name: string
    ) {
      return {
        name,
        create: expoFileSystemMock.directoryCreate,
        exists: false,
        delete: expoFileSystemMock.directoryDelete,
      };
    });

    expect(() => {
      clearToolCardImageCache();
    }).not.toThrow();
    expect(expoFileSystemMock.directoryDelete).not.toHaveBeenCalled();
  });
});

describe('cacheToolAttachment write lifetime', () => {
  it('reports pending before the write resolves and records the URI only afterwards', async () => {
    const write = Promise.withResolvers<undefined>();
    expoFileSystemMock.File.mockImplementationOnce(function FilePending(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: false,
        uri: `file:///cache/tool-card-images/${filename}`,
        write: vi.fn(() => write.promise),
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    cacheToolAttachment('part-slow', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });

    await drainCacheWrites();
    expect(getToolCardImageUri('part-slow')).toBeUndefined();
    expect(isToolCardImagePending('part-slow')).toBe(true);

    write.resolve(undefined);
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-slow')).toBe('file:///cache/tool-card-images/part-slow.png');
    });
    expect(isToolCardImagePending('part-slow')).toBe(false);
  });

  it('does not publish a write that resolves after a sign-out reset', async () => {
    const write = Promise.withResolvers<undefined>();
    expoFileSystemMock.File.mockImplementationOnce(function FilePending(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: false,
        uri: `file:///cache/tool-card-images/${filename}`,
        write: vi.fn(() => write.promise),
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    cacheToolAttachment('part-late', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    clearToolCardImageCache();
    write.resolve(undefined);
    await drainCacheWrites();

    expect(getToolCardImageUri('part-late')).toBeUndefined();
  });

  it('retries the directory creation after a failed create', async () => {
    expoFileSystemMock.directoryCreate.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    cacheToolAttachment('part-retry', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await drainCacheWrites();
    expect(getToolCardImageUri('part-retry')).toBeUndefined();
    expect(isToolCardImagePending('part-retry')).toBe(false);

    cacheToolAttachment('part-retry', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-retry')).toBe(
        'file:///cache/tool-card-images/part-retry.png'
      );
    });
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledTimes(2);
  });
});

describe('useToolCardImageUri', () => {
  it('wakes only the subscribers of the part whose URI was recorded', async () => {
    const rendersA = vi.fn<() => void>();
    const rendersB = vi.fn<() => void>();
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(
        createElement(
          'View',
          null,
          createElement(UriProbe, { partId: 'part-a', onRender: rendersA }),
          createElement(UriProbe, { partId: 'part-b', onRender: rendersB })
        )
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    expect(rendersA).toHaveBeenCalledTimes(1);
    expect(rendersB).toHaveBeenCalledTimes(1);

    cacheToolAttachment('part-a', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-a')).toBe('file:///cache/tool-card-images/part-a.png');
    });
    await drainCacheWrites();

    // part-a re-renders for its pending state and again for its recorded URI;
    // part-b's subscriber is never woken.
    expect(rendersA.mock.calls.length).toBeGreaterThan(1);
    expect(rendersB).toHaveBeenCalledTimes(1);
    expect(getToolCardImageUri('part-b')).toBeUndefined();

    renderer.unmount();
  });
});

function UriProbe({ partId, onRender }: { partId: string; onRender: () => void }) {
  const uri = useToolCardImageUri(partId);
  onRender();
  return createElement('Text', null, uri ?? 'none');
}
