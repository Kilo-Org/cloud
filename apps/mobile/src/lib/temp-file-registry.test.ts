import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTempFileRegistryForTests,
  reapTempFiles,
  registerTempFile,
  TEMP_FILE_TTL_MS,
} from '@/lib/temp-file-registry';

const REGISTRY_URI = 'file:///cache/temp-file-registry.json';

/** In-memory filesystem for the test: uri → file content. */
const fileStore = new Map<string, string>();

const expoFileSystemMock = vi.hoisted(() => {
  const File = vi.fn(function FileMock(_base: unknown, ...rest: unknown[]) {
    const uri =
      rest.length > 0 ? `${(_base as { uri: string }).uri}/${String(rest[0])}` : String(_base);
    return {
      uri,
      get exists() {
        return fileStore.has(uri);
      },
      write(content: string) {
        fileStore.set(uri, content);
      },
      textSync() {
        return fileStore.get(uri) ?? '';
      },
      delete() {
        fileStore.delete(uri);
      },
    };
  });
  return {
    File,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

vi.mock('expo-file-system', () => ({
  File: expoFileSystemMock.File,
  Paths: expoFileSystemMock.Paths,
}));

function readRegistry(): { uri: string; createdAt: number }[] {
  return JSON.parse(fileStore.get(REGISTRY_URI) ?? '[]') as { uri: string; createdAt: number }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  fileStore.clear();
  __resetTempFileRegistryForTests();
});

describe('registerTempFile', () => {
  it('persists the uri with a createdAt timestamp', () => {
    registerTempFile('file:///cache/a.txt');

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0]?.uri).toBe('file:///cache/a.txt');
    expect(registry[0]?.createdAt).toBeTypeOf('number');
  });

  it('is idempotent per uri', () => {
    registerTempFile('file:///cache/dup.txt');
    registerTempFile('file:///cache/dup.txt');

    expect(readRegistry()).toHaveLength(1);
  });
});

describe('reapTempFiles', () => {
  it('deletes every registered file when all is true and clears the list', () => {
    registerTempFile('file:///cache/a.txt');
    registerTempFile('file:///cache/b.txt');
    fileStore.set('file:///cache/a.txt', 'a');
    fileStore.set('file:///cache/b.txt', 'b');

    reapTempFiles({ all: true });

    expect(fileStore.has('file:///cache/a.txt')).toBe(false);
    expect(fileStore.has('file:///cache/b.txt')).toBe(false);
    expect(readRegistry()).toEqual([]);
  });

  it('deletes files older than the TTL and keeps fresh ones', () => {
    const now = Date.now();
    fileStore.set(
      REGISTRY_URI,
      JSON.stringify([
        { uri: 'file:///cache/old.txt', createdAt: now - TEMP_FILE_TTL_MS - 1 },
        { uri: 'file:///cache/fresh.txt', createdAt: now },
      ])
    );
    fileStore.set('file:///cache/old.txt', 'old');
    fileStore.set('file:///cache/fresh.txt', 'fresh');

    reapTempFiles();

    expect(fileStore.has('file:///cache/old.txt')).toBe(false);
    expect(fileStore.has('file:///cache/fresh.txt')).toBe(true);
    expect(readRegistry()).toEqual([{ uri: 'file:///cache/fresh.txt', createdAt: now }]);
  });

  it('does not throw when a registered file is already missing', () => {
    registerTempFile('file:///cache/gone.txt');
    // The file is never written, so it is missing at reap time.

    expect(() => {
      reapTempFiles({ all: true });
    }).not.toThrow();
    expect(readRegistry()).toEqual([]);
  });
});
