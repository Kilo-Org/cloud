/* eslint-disable max-lines -- cohesive unit suite for the file-part cache: capture, overwrite, resolve-failed, and hook-subscription paths share one mock harness */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React trees under vitest (same pattern as src/components/agents/attachment-preview-strip.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetFilePartCacheForTests,
  cacheFilePart,
  clearFilePartResolveFailed,
  getFilePartCacheEntry,
  isUsableFilePartUrl,
  markFilePartResolveFailed,
  overwriteFilePartCacheEntry,
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

  it('stores a ref-only entry for a cloud-agent attachment file:// URL', () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    cacheFilePart('part-attach', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });

    expect(fileInstances).toHaveLength(0);
    expect(getFilePartCacheEntry('part-attach')).toEqual({
      mime: 'text/markdown',
      filename: `${uuid}.md`,
      attachmentRef: { messageUuid: uuid, filename: `${uuid}.md` },
    });
    expect(getFilePartCacheEntry('part-attach')).not.toHaveProperty('url');
  });
});

describe('overwriteFilePartCacheEntry', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('replaces url, preserves attachmentRef, and emits', async () => {
    cacheFilePart('part-overwrite', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    const renderer = await mountProbe('part-overwrite');

    await act(async () => {
      await Promise.resolve();
      overwriteFilePartCacheEntry('part-overwrite', {
        url: 'https://r2.example/signed',
        mime: 'text/markdown',
        filename: `${uuid}.md`,
      });
    });

    expect(textOf(renderer)).toBe('https://r2.example/signed|ok');
    expect(getFilePartCacheEntry('part-overwrite')).toEqual({
      url: 'https://r2.example/signed',
      mime: 'text/markdown',
      filename: `${uuid}.md`,
      attachmentRef: { messageUuid: uuid, filename: `${uuid}.md` },
    });
    renderer.unmount();
  });

  it('keeps attachmentRef and clears resolveFailed after a failed resolve', () => {
    cacheFilePart('part-overwrite-failed', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/${uuid}.md`,
      mime: 'text/markdown',
      filename: `${uuid}.md`,
    });
    markFilePartResolveFailed('part-overwrite-failed');

    overwriteFilePartCacheEntry('part-overwrite-failed', {
      url: 'https://example.com/fresh.md',
      mime: 'text/markdown',
      filename: 'fresh.md',
    });

    expect(getFilePartCacheEntry('part-overwrite-failed')).toEqual({
      url: 'https://example.com/fresh.md',
      mime: 'text/markdown',
      filename: 'fresh.md',
      attachmentRef: { messageUuid: uuid, filename: `${uuid}.md` },
    });
    expect(getFilePartCacheEntry('part-overwrite-failed')).not.toHaveProperty('resolveFailed');
  });

  it('does not overwrite or emit when the payload URL is unusable', async () => {
    cacheFilePart('part-overwrite-unusable', {
      url: 'https://example.com/keep.md',
      mime: 'text/markdown',
      filename: 'keep.md',
    });
    const before = getFilePartCacheEntry('part-overwrite-unusable');

    const onRender = vi.fn<() => void>();
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      await Promise.resolve();
      ref.current = TestRenderer.create(
        createElement(CountingProbe, { partId: 'part-overwrite-unusable', onRender })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    const rendersBefore = onRender.mock.calls.length;
    expect(textOf(renderer)).toBe('https://example.com/keep.md');

    await act(async () => {
      await Promise.resolve();
      overwriteFilePartCacheEntry('part-overwrite-unusable', {
        url: 'file:///etc/passwd',
        mime: 'text/plain',
        filename: 'x.txt',
      });
    });

    expect(getFilePartCacheEntry('part-overwrite-unusable')).toBe(before);
    expect(textOf(renderer)).toBe('https://example.com/keep.md');
    expect(onRender.mock.calls.length).toBe(rendersBefore);

    renderer.unmount();
  });
});

describe('markFilePartResolveFailed / clearFilePartResolveFailed', () => {
  const uuid = '11111111-2222-4333-8444-555555555555';

  it('marks on a new identity, clears the key, and emits', async () => {
    cacheFilePart('part-fail', {
      url: `file:///tmp/attachments/agent-1/user-1/${uuid}/x.md`,
      mime: 'text/markdown',
      filename: 'x.md',
    });
    const before = getFilePartCacheEntry('part-fail');
    const renderer = await mountProbe('part-fail');

    await act(async () => {
      await Promise.resolve();
      markFilePartResolveFailed('part-fail');
    });
    const marked = getFilePartCacheEntry('part-fail');
    expect(marked?.resolveFailed).toBe(true);
    expect(marked).not.toBe(before);
    expect(textOf(renderer)).toBe('none|failed');

    await act(async () => {
      await Promise.resolve();
      clearFilePartResolveFailed('part-fail');
    });
    const cleared = getFilePartCacheEntry('part-fail');
    expect(cleared).not.toHaveProperty('resolveFailed');
    expect(cleared).not.toBe(marked);
    expect(textOf(renderer)).toBe('none|ok');

    renderer.unmount();
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

function EntryProbe({ partId }: { partId: string }) {
  const entry = useFilePartCache(partId);
  const failed = entry?.resolveFailed === true ? 'failed' : 'ok';
  return createElement('Text', null, `${entry?.url ?? 'none'}|${failed}`);
}

function CountingProbe({ partId, onRender }: { partId: string; onRender: () => void }) {
  const entry = useFilePartCache(partId);
  onRender();
  return createElement('Text', null, entry?.url ?? 'none');
}

async function mountProbe(partId: string): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(EntryProbe, { partId }));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
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
