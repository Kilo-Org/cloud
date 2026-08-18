/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFilePartCacheForTests,
  cacheFilePart,
  getFilePartCacheEntry,
  isUsableFilePartUrl,
  useFilePartCache,
} from '@/components/agents/file-part-cache';

type FileInstance = {
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
  const File = vi.fn(function FileMock(_directory: { name?: string }, filename: string) {
    const instance = {
      uri: `file:///cache/session-file-parts/${filename}`,
      write: vi.fn(),
      filename,
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
  __resetFilePartCacheForTests();
});

describe('cacheFilePart', () => {
  it('records url, mime, and filename for a part id', () => {
    cacheFilePart('part-1', {
      url: 'https://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(getFilePartCacheEntry('part-1')).toEqual({
      url: 'https://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });
  });

  it('omits filename when the payload has none', () => {
    cacheFilePart('part-img', { url: 'https://example.com/a.png', mime: 'image/png' });

    expect(getFilePartCacheEntry('part-img')).toEqual({
      url: 'https://example.com/a.png',
      mime: 'image/png',
    });
  });

  it('first write wins for a duplicate part id', () => {
    cacheFilePart('part-dup', { url: 'https://example.com/a.png', mime: 'image/png' });
    cacheFilePart('part-dup', { url: 'https://example.com/b.png', mime: 'image/png' });

    expect(getFilePartCacheEntry('part-dup')).toEqual({
      url: 'https://example.com/a.png',
      mime: 'image/png',
    });
  });

  it('writes a data: URL to disk and stores the file:// URI', () => {
    cacheFilePart('part-1', {
      url: 'data:application/pdf;base64,QUJD',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(expoFileSystemMock.Directory).toHaveBeenCalledWith(
      'file:///cache',
      'session-file-parts'
    );
    expect(expoFileSystemMock.directoryCreate).toHaveBeenCalledWith({
      idempotent: true,
      intermediates: true,
    });
    const file = fileInstances[0];
    expect(file?.filename).toBe('part-1-report.pdf');
    expect(file?.write).toHaveBeenCalledWith('QUJD', { encoding: 'base64' });
    expect(getFilePartCacheEntry('part-1')?.url).toBe(
      'file:///cache/session-file-parts/part-1-report.pdf'
    );
  });

  it('stores an http(s) URL as-is without writing to disk', () => {
    cacheFilePart('part-1', {
      url: 'https://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(fileInstances).toHaveLength(0);
    expect(getFilePartCacheEntry('part-1')?.url).toBe('https://example.com/report.pdf');
  });

  it('stores the raw URL when the data: prefix cannot be stripped', () => {
    cacheFilePart('part-1', {
      url: 'data:text/plain,hello',
      mime: 'text/plain',
      filename: 'note.txt',
    });

    expect(fileInstances).toHaveLength(0);
    expect(getFilePartCacheEntry('part-1')?.url).toBe('data:text/plain,hello');
  });

  it('stores the raw URL when the disk write fails', () => {
    expoFileSystemMock.File.mockImplementationOnce(function FileFail(
      _directory: { name?: string },
      filename: string
    ) {
      const instance = {
        uri: `file:///cache/session-file-parts/${filename}`,
        write: vi.fn(() => {
          throw new Error('disk full');
        }),
        filename,
      };
      fileInstances.push(instance);
      return instance;
    });

    expect(() => {
      cacheFilePart('part-1', {
        url: 'data:application/pdf;base64,QUJD',
        mime: 'application/pdf',
        filename: 'report.pdf',
      });
    }).not.toThrow();

    expect(getFilePartCacheEntry('part-1')?.url).toBe('data:application/pdf;base64,QUJD');
  });

  it('does not store a file:// URL', () => {
    cacheFilePart('part-1', {
      url: 'file:///etc/passwd',
      mime: 'text/plain',
      filename: 'passwd',
    });

    expect(fileInstances).toHaveLength(0);
    expect(getFilePartCacheEntry('part-1')).toBeUndefined();
  });

  it('does not store a non-http(s)/data: URL', () => {
    cacheFilePart('part-1', {
      url: 'ftp://example.com/report.pdf',
      mime: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(fileInstances).toHaveLength(0);
    expect(getFilePartCacheEntry('part-1')).toBeUndefined();
  });
});

describe('isUsableFilePartUrl', () => {
  it('accepts http, https, and data schemes', () => {
    expect(isUsableFilePartUrl('http://example.com/a.png')).toBe(true);
    expect(isUsableFilePartUrl('https://example.com/a.png')).toBe(true);
    expect(isUsableFilePartUrl('data:image/png;base64,AAA')).toBe(true);
  });

  it('rejects file and other schemes', () => {
    expect(isUsableFilePartUrl('file:///cache/a.png')).toBe(false);
    expect(isUsableFilePartUrl('ftp://example.com/a.png')).toBe(false);
    expect(isUsableFilePartUrl('')).toBe(false);
  });
});

function Probe({ partId }: { partId: string }) {
  const entry = useFilePartCache(partId);
  return createElement('Text', null, entry?.url ?? 'none');
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string | undefined {
  const node = renderer.root.find(n => typeof n.type === 'string' && (n.type as string) === 'Text');
  return node.props.children as string | undefined;
}

describe('useFilePartCache', () => {
  it('re-renders a subscriber when a new part is cached', async () => {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(createElement(Probe, { partId: 'p1' }));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    expect(textOf(renderer)).toBe('none');

    await act(async () => {
      await Promise.resolve();
      cacheFilePart('p1', { url: 'https://example.com/a.png', mime: 'image/png' });
    });

    expect(textOf(renderer)).toBe('https://example.com/a.png');

    renderer.unmount();
  });

  it('reads the same store as getFilePartCacheEntry', () => {
    expect(typeof useFilePartCache).toBe('function');
    expect(getFilePartCacheEntry('missing')).toBeUndefined();
    cacheFilePart('part-hook', { url: 'https://example.com/a.png', mime: 'image/png' });
    expect(getFilePartCacheEntry('part-hook')?.url).toBe('https://example.com/a.png');
  });
});
