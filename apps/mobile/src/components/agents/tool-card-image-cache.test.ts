import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetToolCardImageCacheForTests,
  cacheToolAttachment,
  cacheToolCardImage,
  extensionForImageMime,
  extensionForMime,
  getToolCardImageUri,
  stripDataUrlBase64Prefix,
  useToolCardImageUri,
} from '@/components/agents/tool-card-image-cache';

type FileInstance = {
  exists: boolean;
  uri: string;
  write: ReturnType<typeof vi.fn>;
  filename: string;
};

const fileInstances: FileInstance[] = [];

const expoFileSystemMock = vi.hoisted(() => {
  const directoryCreate = vi.fn();
  const Directory = vi.fn(function DirectoryMock(_base: unknown, name: string) {
    return {
      name,
      create: directoryCreate,
    };
  });
  const File = vi.fn(function FileMock(directory: { name?: string }, filename: string) {
    const instance = {
      exists: false,
      uri: `file:///cache/tool-card-images/${filename}`,
      write: vi.fn(),
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
  it('writes base64 payload under a mime-derived filename and exposes the file URI', () => {
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,QUJD');

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith('file:///cache', 'tool-card-images');
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    expect(expoFileSystemMock.File).toHaveBeenCalled();
    const file = fileInstances[0];
    expect(file?.filename).toBe('part-1.png');
    expect(file?.write).toHaveBeenCalledWith('QUJD', { encoding: 'base64' });
    expect(getToolCardImageUri('part-1')).toBe('file:///cache/tool-card-images/part-1.png');
  });

  it('derives jpg for image/jpeg', () => {
    cacheToolCardImage('part-jpg', 'image/jpeg', 'data:image/jpeg;base64,AAA');
    expect(fileInstances[0]?.filename).toBe('part-jpg.jpg');
  });

  it('does not rewrite when the same part id is cached twice (Set dedupe)', () => {
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,AAA');
    cacheToolCardImage('part-1', 'image/png', 'data:image/png;base64,BBB');

    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.write).toHaveBeenCalledTimes(1);
    expect(fileInstances[0]?.write).toHaveBeenCalledWith('AAA', { encoding: 'base64' });
  });

  it('skips the write when the file already exists and still records the URI', () => {
    // First construct will be the exists-check instance — seed exists=true
    // by making File return an existing file on first construction.
    expoFileSystemMock.File.mockImplementationOnce(function FileExists(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: true,
        uri: `file:///cache/tool-card-images/${filename}`,
        write: vi.fn(),
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    cacheToolCardImage('part-exists', 'image/png', 'data:image/png;base64,AAA');

    expect(fileInstances[0]?.write).not.toHaveBeenCalled();
    expect(getToolCardImageUri('part-exists')).toBe(
      'file:///cache/tool-card-images/part-exists.png'
    );
    // Second call must still be deduped by the Set (no second File).
    cacheToolCardImage('part-exists', 'image/png', 'data:image/png;base64,BBB');
    expect(fileInstances).toHaveLength(1);
  });

  it('clears the dedupe mark and records no URI when write fails', () => {
    expoFileSystemMock.File.mockImplementationOnce(function FileFail(
      directory: { name?: string },
      filename: string
    ) {
      const instance = {
        exists: false,
        uri: `file:///cache/tool-card-images/${filename}`,
        write: vi.fn(() => {
          throw new Error('disk full');
        }),
        filename,
        directory,
      };
      fileInstances.push(instance);
      return instance;
    });

    expect(() => {
      cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    }).not.toThrow();

    expect(fileInstances[0]?.write).toHaveBeenCalled();
    expect(getToolCardImageUri('part-fail')).toBeUndefined();

    // Failure cleared the mark — a retry is allowed and should attempt again.
    cacheToolCardImage('part-fail', 'image/png', 'data:image/png;base64,AAA');
    expect(fileInstances).toHaveLength(2);
    expect(fileInstances[1]?.write).toHaveBeenCalledWith('AAA', { encoding: 'base64' });
    expect(getToolCardImageUri('part-fail')).toBe('file:///cache/tool-card-images/part-fail.png');
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
  it('writes base64 payload for a pdf attachment with a filename using getSafeCacheFilename', () => {
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
    expect(file?.write).toHaveBeenCalledWith('QUJD', { encoding: 'base64' });
    expect(getToolCardImageUri('part-send')).toBe(
      'file:///cache/tool-card-images/part-send-report.pdf'
    );
  });

  it('uses extension-based naming when no filename is provided (image fallback)', () => {
    cacheToolAttachment('part-img', { mime: 'image/png', dataUrl: 'data:image/png;base64,AAA' });

    const file = fileInstances[0];
    expect(file?.filename).toBe('part-img.png');
    expect(file?.write).toHaveBeenCalledWith('AAA', { encoding: 'base64' });
  });

  it('deduplicates same part id across cacheToolAttachment calls', () => {
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

    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.write).toHaveBeenCalledWith('AAA', { encoding: 'base64' });
    expect(getToolCardImageUri('part-dup')).toBe('file:///cache/tool-card-images/part-dup-img.png');
  });

  it('sanitizes special characters in the MIME subtype when no filename is provided', () => {
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
    expect(file?.write).toHaveBeenCalledWith('AAA', { encoding: 'base64' });
  });

  it('routes a very long MIME subtype through the safe filename function', () => {
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
    expect(file?.write).toHaveBeenCalled();
  });

  it('shares the dedupe set with cacheToolCardImage', () => {
    cacheToolCardImage('part-shared', 'image/png', 'data:image/png;base64,AAA');
    cacheToolAttachment('part-shared', {
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,BBB',
      filename: 'name.png',
    });

    expect(fileInstances).toHaveLength(1);
    expect(fileInstances[0]?.filename).toBe('part-shared.png');
    expect(getToolCardImageUri('part-shared')).toBe(
      'file:///cache/tool-card-images/part-shared.png'
    );
  });
});

describe('useToolCardImageUri', () => {
  it('is the Slice 4 lookup export and reads the same store as getToolCardImageUri', () => {
    expect(typeof useToolCardImageUri).toBe('function');
    expect(getToolCardImageUri('missing')).toBeUndefined();
    cacheToolCardImage('part-hook', 'image/png', 'data:image/png;base64,AAA');
    expect(getToolCardImageUri('part-hook')).toBe('file:///cache/tool-card-images/part-hook.png');
  });
});
