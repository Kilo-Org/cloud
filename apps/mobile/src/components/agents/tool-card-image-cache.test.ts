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
  size: number;
  uri: string;
  written?: { content: string; encoding?: string };
  write: (content: string, options?: { encoding?: string }) => Promise<void>;
  move: (destination: unknown, options?: { overwrite?: boolean }) => Promise<void>;
  delete?: () => void;
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
  const File = vi.fn(function FileMock(
    directory: { name?: string },
    filename: string
  ): FileInstance {
    const instance: FileInstance = {
      exists: false,
      size: 0,
      uri: `file:///cache/tool-card-images/${filename}`,
      write: (content: string, options?: { encoding?: string }) => {
        instance.written = { content, encoding: options?.encoding };
        return Promise.resolve();
      },
      move: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => undefined),
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

/** The instance created for a final cache name — the exists-check target. */
function finalInstanceFor(finalName: string): FileInstance | undefined {
  return fileInstances.find(instance => instance.filename === finalName);
}

/** The latest `<final>.tmp-<n>` sibling created for a part's write attempts. */
function tempInstanceFor(finalName: string): FileInstance | undefined {
  const temps = fileInstances.filter(instance => instance.filename.startsWith(`${finalName}.tmp-`));
  return temps.at(-1);
}

/** Instances created for final cache names (every write also builds one temp sibling). */
function finalInstances(): FileInstance[] {
  return fileInstances.filter(instance => !instance.filename.includes('.tmp-'));
}

/**
 * Queues the two one-shot File mocks a write attempt builds: the final-name
 * instance (default mock) and the `<final>.tmp-<n>` sibling whose `write` is
 * the pending/failing one. The default factory is re-entered so every other
 * member keeps its default behavior.
 */
function mockTempWrite(write: () => Promise<void>): void {
  const defaultFactory = expoFileSystemMock.File.getMockImplementation();
  expoFileSystemMock.File.mockImplementationOnce(function FileFinal(
    directory: { name?: string },
    filename: string
  ) {
    const existing = defaultFactory?.(directory, filename) as FileInstance;
    expoFileSystemMock.File.mockImplementationOnce(function FileTemp(
      dir: { name?: string },
      name: string
    ) {
      const instance: FileInstance = {
        ...(defaultFactory?.(dir, name) as FileInstance),
        write: vi.fn(write),
      };
      fileInstances.push(instance);
      return instance;
    });
    return existing;
  });
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
    const file = tempInstanceFor('part-1.png');
    expect(file?.filename).toMatch(/^part-1\.png\.tmp-\d+$/);
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
    expect(finalInstances()).toHaveLength(1);
    expect(tempInstanceFor('part-1.png')?.written).toEqual({
      content: 'AAA',
      encoding: 'base64',
    });
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
        size: 2,
        uri: `file:///cache/tool-card-images/${filename}`,
        write,
        move: vi.fn(() => Promise.resolve()),
        delete: vi.fn(),
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

  it('latches the part after a failed write until the cache is cleared', async () => {
    mockTempWrite(() => Promise.reject(new Error('disk full')));

    expect(() => {
      cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    }).not.toThrow();

    await drainCacheWrites();
    expect(getToolCardImageUri('part-fail')).toBeUndefined();

    // The failure latches the part: the next pass performs no file-system work
    // at all — no File construction, no retry — until a clear resets the latch.
    cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    await drainCacheWrites();
    expect(finalInstances()).toHaveLength(1);
    expect(getToolCardImageUri('part-fail')).toBeUndefined();

    clearToolCardImageCache();
    cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-fail')).toBe('file:///cache/tool-card-images/part-fail.png');
    });
    expect(finalInstances()).toHaveLength(2);
    expect(tempInstanceFor('part-fail.png')?.written).toEqual({
      content: 'AAA',
      encoding: 'base64',
    });
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
    const file = tempInstanceFor('part-send-report.pdf');
    // getSafeCacheFilename({ id: 'part-send', filename: 'report.pdf' })
    //  → 'part-send-report.pdf' (after sanitization)
    expect(file?.filename).toMatch(/^part-send-report\.pdf\.tmp-\d+$/);
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-send')).toBe(
        'file:///cache/tool-card-images/part-send-report.pdf'
      );
    });
    expect(file?.written).toEqual({ content: 'QUJD', encoding: 'base64' });
  });

  it('uses extension-based naming when no filename is provided (image fallback)', async () => {
    cacheToolAttachment('part-img', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });

    const file = tempInstanceFor('part-img.png');
    expect(file?.filename).toMatch(/^part-img\.png\.tmp-\d+$/);

    await vi.waitFor(() => {
      expect(file?.written).toEqual({ content: 'AAA', encoding: 'base64' });
    });
  });

  it('preserves _DOT_ in the partId, replacing only the appended final -_DOT_ suffix', async () => {
    cacheToolAttachment('part-_DOT_42', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
    });

    const file = tempInstanceFor('part-_DOT_42.png');
    // partId "part-_DOT_42" + filename "_DOT_png" →
    //   mock getSafeCacheFilename → "part-_DOT_42-_DOT_png"
    //   _DOT_ in partId must survive; only final -_DOT_ before ext is replaced →
    //   "part-_DOT_42.png"
    expect(file?.filename).toMatch(/^part-_DOT_42\.png\.tmp-\d+$/);
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
    expect(finalInstances()).toHaveLength(1);
    expect(tempInstanceFor('part-dup-img.png')?.written).toEqual({
      content: 'AAA',
      encoding: 'base64',
    });
  });

  it('sanitizes special characters in the MIME subtype when no filename is provided', async () => {
    // The subtype "vnd.<script>alert" contains < and > which are unsafe in
    // filenames.  The safe-cache-filename logic must strip them.
    cacheToolAttachment('part-xss', {
      mime: 'application/vnd.<script>alert',
      dataUrl: 'data:application/vnd.<script>alert;base64,AAA',
    });

    const file = tempInstanceFor('part-xss.vnd._script_alert');
    // getSafeCacheFilename({ id: 'part-xss', filename: 'vnd.<script>alert' })
    // mock sanitizes → 'vnd._script_alert'
    expect(file?.filename).toMatch(/^part-xss\.vnd\._script_alert\.tmp-\d+$/);
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

    const file = fileInstances[1];
    // The mock does not truncate, but the real getSafeCacheFilename bounds
    // to 255 bytes.  This test verifies the code path routes through the safe
    // function instead of raw concatenation (the temp sibling carries that
    // name plus the `.tmp-<n>` suffix).
    expect(file?.filename).toMatch(/^part-long\..*\.tmp-\d+$/);
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

    expect(finalInstances()).toHaveLength(1);
    expect(finalInstances()[0]?.filename).toBe('part-shared.png');
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
    expect(finalInstances()).toHaveLength(2);
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
    mockTempWrite(() => write.promise);

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
    mockTempWrite(() => write.promise);

    cacheToolAttachment('part-late', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    clearToolCardImageCache();
    write.resolve(undefined);
    await drainCacheWrites();

    expect(getToolCardImageUri('part-late')).toBeUndefined();
  });

  it('does not retry a failed create: the latch holds until the cache is cleared', async () => {
    expoFileSystemMock.directoryCreate.mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });

    cacheToolAttachment('part-retry', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await drainCacheWrites();
    expect(getToolCardImageUri('part-retry')).toBeUndefined();
    expect(isToolCardImagePending('part-retry')).toBe(false);

    // The immediate retry is a no-op now: the latched part performs no
    // file-system work, so the directory create runs exactly once until the
    // next clear.
    cacheToolAttachment('part-retry', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await drainCacheWrites();
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledTimes(1);
    expect(getToolCardImageUri('part-retry')).toBeUndefined();

    clearToolCardImageCache();
    cacheToolAttachment('part-retry', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-retry')).toBe(
        'file:///cache/tool-card-images/part-retry.png'
      );
    });
    // One create from the first attempt and one from the post-clear attempt.
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledTimes(2);
  });

  it('interrupted write leaves no final file, publishes no URI, and latches the part', async () => {
    // The write "rejects midway": the failing instance is the temp sibling, the
    // second construction after the final-name exists check.
    mockTempWrite(() => Promise.reject(new Error('interrupted')));

    cacheToolAttachment('part-partial', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
    });
    await drainCacheWrites();

    // The temp sibling was deleted best-effort and nothing exists under the
    // final name: only the temp instance and its delete exist.
    expect(tempInstanceFor('part-partial.png')?.delete).toHaveBeenCalledTimes(1);
    expect(finalInstanceFor('part-partial.png')).toBeDefined();
    expect(tempInstanceFor('part-partial.png')?.move).not.toHaveBeenCalled();
    expect(finalInstanceFor('part-partial.png')?.written).toBeUndefined();
    expect(getToolCardImageUri('part-partial')).toBeUndefined();

    // The latch means a later pass performs no file-system work at all.
    cacheToolAttachment('part-partial', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
    });
    await drainCacheWrites();
    expect(finalInstances()).toHaveLength(1);
    expect(tempInstanceFor('part-partial.png')?.delete).toHaveBeenCalledTimes(1);
    expect(getToolCardImageUri('part-partial')).toBeUndefined();
  });

  it('a write resolving after a clear publishes nothing in the new generation', async () => {
    const write = Promise.withResolvers<undefined>();
    mockTempWrite(() => write.promise);

    cacheToolAttachment('part-stale', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await drainCacheWrites();
    expect(isToolCardImagePending('part-stale')).toBe(true);

    clearToolCardImageCache();
    write.resolve(undefined);
    await drainCacheWrites();

    // The rekeyed attempt owns nothing anymore: no pending or dedupe mark, no
    // latch, no URI, and no wake of its subscribers.
    expect(getToolCardImageUri('part-stale')).toBeUndefined();
    expect(isToolCardImagePending('part-stale')).toBe(false);
    expect(finalInstances()).toHaveLength(1);
    expect(tempInstanceFor('part-stale.png')?.move).not.toHaveBeenCalled();
    expect(tempInstanceFor('part-stale.png')?.delete).not.toHaveBeenCalled();

    // In the new generation, the same part id proceeds normally: its own File
    // is constructed, the write runs, and the URI publishes.
    cacheToolAttachment('part-stale', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });
    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-stale')).toBe(
        'file:///cache/tool-card-images/part-stale.png'
      );
    });
    expect(isToolCardImagePending('part-stale')).toBe(false);
    expect(finalInstances()).toHaveLength(2);
    expect(tempInstanceFor('part-stale.png')?.written).toEqual({
      content: 'AAA',
      encoding: 'base64',
    });
  });

  it('cleans up the temp file when the write fails', async () => {
    mockTempWrite(() => Promise.reject(new Error('disk full')));

    cacheToolAttachment('part-cleanup', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AAA',
    });
    await drainCacheWrites();

    const temp = tempInstanceFor('part-cleanup.png');
    expect(temp).toBeDefined();
    expect(temp?.delete).toHaveBeenCalledTimes(1);
    expect(temp?.filename).toMatch(/^part-cleanup\.png\.tmp-\d+$/);
  });

  it('rewrites a truncated file that exists under the final name', async () => {
    // 'QUJDRA==' decodes to the 4 bytes 'ABCD'; the seeded instance holds only
    // 2 bytes, as an interrupted legacy write would leave. The write path runs:
    // a temp sibling carries the payload and moves onto the truncated file.
    const defaultFactory = expoFileSystemMock.File.getMockImplementation();
    expoFileSystemMock.File.mockImplementationOnce(function FileTruncated(
      directory: { name?: string },
      filename: string
    ) {
      // Mutate the recorded instance so the array copy matches what the cache
      // observed; a spread copy would leave `fileInstances` describing an
      // absent zero-byte file.
      const instance = defaultFactory?.(directory, filename) as FileInstance;
      instance.exists = true;
      instance.size = 2;
      return instance;
    });

    cacheToolAttachment('part-truncated', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,QUJDRA==',
    });

    await vi.waitFor(() => {
      expect(getToolCardImageUri('part-truncated')).toBe(
        'file:///cache/tool-card-images/part-truncated.png'
      );
    });

    // The write path ran against a fresh temp sibling and moved it over the
    // truncated file instead of publishing the truncated body.
    const temp = tempInstanceFor('part-truncated.png');
    expect(temp).toBeDefined();
    expect(temp?.written).toEqual({ content: 'QUJDRA==', encoding: 'base64' });
    expect(temp?.move).toHaveBeenCalledTimes(1);
    expect(finalInstanceFor('part-truncated.png')?.written).toBeUndefined();
    expect(finalInstances()).toHaveLength(1);
    expect(isToolCardImagePending('part-truncated')).toBe(false);
  });

  it('does not rewrite a file whose size already matches the decoded payload', async () => {
    // 'QUJDRA==' decodes to 4 bytes; the seeded instance holds exactly that.
    const defaultFactory = expoFileSystemMock.File.getMockImplementation();
    expoFileSystemMock.File.mockImplementationOnce(function FileComplete(
      directory: { name?: string },
      filename: string
    ) {
      // Mutate the recorded instance, matching what the cache observed.
      const instance = defaultFactory?.(directory, filename) as FileInstance;
      instance.exists = true;
      instance.size = 4;
      return instance;
    });

    cacheToolAttachment('part-complete', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,QUJDRA==',
    });
    await drainCacheWrites();

    expect(getToolCardImageUri('part-complete')).toBe(
      'file:///cache/tool-card-images/part-complete.png'
    );
    expect(tempInstanceFor('part-complete.png')).toBeUndefined();
    expect(finalInstanceFor('part-complete.png')?.written).toBeUndefined();
    expect(finalInstances()).toHaveLength(1);
    expect(isToolCardImagePending('part-complete')).toBe(false);
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
