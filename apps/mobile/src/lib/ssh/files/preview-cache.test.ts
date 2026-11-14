import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeFs } from './fake-file-system.test-helpers';
import { allocatePreviewCache, sweepPreviewCache } from './preview-cache';

vi.mock('expo-file-system', async () => {
  const { fakeFs: fake } = await import('./fake-file-system.test-helpers');
  return { Directory: fake.Directory, File: fake.File, Paths: fake.Paths };
});

vi.mock('@/lib/share-remote-file', () => ({
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) => `${id}-${filename}`,
}));

const previewDirectory = 'file:///cache/ssh-file-previews';
const allocated: { release: () => void }[] = [];

function allocate(name: string) {
  const cache = allocatePreviewCache(name);
  allocated.push(cache);
  return cache;
}

beforeEach(() => {
  fakeFs.reset();
});

afterEach(() => {
  for (const cache of allocated.splice(0)) {
    cache.release();
  }
});

describe('allocatePreviewCache', () => {
  it('reserves a distinct file per preview under the preview directory', () => {
    const first = allocate('image.png');
    const second = allocate('image.png');

    expect(first.uri).not.toBe(second.uri);
    expect(fakeFs.directories.has(previewDirectory)).toBe(true);
    for (const uri of [first.uri, second.uri]) {
      expect(uri.startsWith(`${previewDirectory}/preview-`)).toBe(true);
      expect(uri.endsWith('-image.png')).toBe(true);
    }
  });

  it('releases the copy once a preview closes', () => {
    const cache = allocate('report.txt');
    fakeFs.files.set(cache.uri, 'text');

    cache.release();

    expect(fakeFs.files.has(cache.uri)).toBe(false);
  });

  it('tolerates repeats and copies that were never written', () => {
    const cache = allocate('empty.png');

    expect(() => {
      cache.release();
      cache.release();
    }).not.toThrow();
  });
});

describe('sweepPreviewCache', () => {
  it('deletes preview copies an earlier mount left behind', () => {
    fakeFs.directories.add(previewDirectory);
    const stale = `${previewDirectory}/preview-old-image.png`;
    fakeFs.files.set(stale, 'bytes');

    sweepPreviewCache();

    expect(fakeFs.files.has(stale)).toBe(false);
  });

  it('keeps a preview another mounted screen still shows', () => {
    const live = allocate('open.png');
    fakeFs.files.set(live.uri, 'bytes');
    const stale = `${previewDirectory}/preview-old-open.png`;
    fakeFs.files.set(stale, 'bytes');

    sweepPreviewCache();

    expect(fakeFs.files.has(live.uri)).toBe(true);
    expect(fakeFs.files.has(stale)).toBe(false);
  });

  it('leaves downloaded and shared copies outside the preview directory', () => {
    fakeFs.directories.add(previewDirectory);
    const stale = `${previewDirectory}/preview-old-image.png`;
    const download = 'file:///cache/ssh-files/transfer-1-report.pdf';
    const shared = 'file:///cache/share-1-report.pdf';
    fakeFs.files.set(stale, 'bytes');
    fakeFs.files.set(download, 'bytes');
    fakeFs.files.set(shared, 'bytes');

    sweepPreviewCache();

    expect(fakeFs.files.has(stale)).toBe(false);
    expect(fakeFs.files.get(download)).toBe('bytes');
    expect(fakeFs.files.get(shared)).toBe('bytes');
  });

  it('does nothing before any preview directory exists', () => {
    const rootCopy = 'file:///cache/share-1-report.pdf';
    fakeFs.files.set(rootCopy, 'bytes');

    expect(() => {
      sweepPreviewCache();
    }).not.toThrow();

    expect(fakeFs.files.get(rootCopy)).toBe('bytes');
  });

  it('leaves the copies for the next startup when the directory cannot be listed', () => {
    fakeFs.directories.add(previewDirectory);
    const stale = `${previewDirectory}/preview-old-image.png`;
    fakeFs.files.set(stale, 'bytes');
    fakeFs.failListing();

    expect(() => {
      sweepPreviewCache();
    }).not.toThrow();

    expect(fakeFs.files.has(stale)).toBe(true);
  });

  it('reaches a copy whose release the platform refused', () => {
    const cache = allocate('locked.png');
    fakeFs.files.set(cache.uri, 'bytes');
    fakeFs.refusedDeletes.add(cache.uri);

    cache.release();
    expect(fakeFs.files.has(cache.uri)).toBe(true);

    sweepPreviewCache();

    expect(fakeFs.files.has(cache.uri)).toBe(false);
  });
});
