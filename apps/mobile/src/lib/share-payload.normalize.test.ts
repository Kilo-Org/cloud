import { describe, expect, it, vi } from 'vitest';

import { normalizeShareIntent } from './share-payload';

vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `id-${n}`;
    },
  };
});

const expoFileSystemMock = vi.hoisted(() => {
  const files = new Map<string, string>();
  const File = vi.fn(function FileMock(_base: unknown, ...rest: unknown[]) {
    const uri =
      rest.length > 0 ? `${(_base as { uri: string }).uri}/${String(rest[0])}` : String(_base);
    return {
      uri,
      get exists() {
        return files.has(uri);
      },
      write(content: string) {
        files.set(uri, content);
      },
      textSync() {
        return files.get(uri) ?? '';
      },
      delete() {
        files.delete(uri);
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

describe('normalizeShareIntent partial copy failures', () => {
  it('one-of-two copy failures keeps text and the successful file', async () => {
    const payload = await normalizeShareIntent(
      {
        text: 'keep me',
        webUrl: null,
        meta: null,
        files: [
          {
            fileName: 'ok.jpg',
            mimeType: 'image/jpeg',
            path: 'file:///share/ok.jpg',
            size: 1,
            width: null,
            height: null,
            duration: null,
          },
          {
            fileName: 'bad.jpg',
            mimeType: 'image/jpeg',
            path: 'file:///share/bad.jpg',
            size: 2,
            width: null,
            height: null,
            duration: null,
          },
        ],
      },
      async ({ from, fileName }) => {
        await Promise.resolve();
        if (from.includes('bad')) {
          throw new Error('copy failed');
        }
        return `file:///cache/copied-${fileName}`;
      }
    );

    expect(payload.text).toBe('keep me');
    expect(payload.files).toEqual([
      {
        name: 'ok.jpg',
        uri: 'file:///cache/copied-ok.jpg',
        mimeType: 'image/jpeg',
        size: 1,
      },
    ]);
    expect(payload.failedFiles).toEqual(['bad.jpg']);
  });

  it('all copy failures with text present return a text-only payload with failed names', async () => {
    const payload = await normalizeShareIntent(
      {
        text: 'text survives',
        webUrl: null,
        meta: null,
        files: [
          {
            fileName: 'a.jpg',
            mimeType: 'image/jpeg',
            path: 'file:///share/a.jpg',
            size: 1,
            width: null,
            height: null,
            duration: null,
          },
          {
            fileName: 'b.jpg',
            mimeType: 'image/jpeg',
            path: 'file:///share/b.jpg',
            size: 2,
            width: null,
            height: null,
            duration: null,
          },
        ],
      },
      async () => {
        await Promise.resolve();
        throw new Error('copy failed');
      }
    );

    expect(payload).toEqual({
      text: 'text survives',
      files: [],
      failedFiles: ['a.jpg', 'b.jpg'],
    });
  });

  it('all copy failures without text resolve to a failed-files payload', async () => {
    const payload = await normalizeShareIntent(
      {
        text: null,
        webUrl: null,
        meta: null,
        files: [
          {
            fileName: 'a.jpg',
            mimeType: 'image/jpeg',
            path: 'file:///share/a.jpg',
            size: 1,
            width: null,
            height: null,
            duration: null,
          },
        ],
      },
      async () => {
        await Promise.resolve();
        throw new Error('copy failed');
      }
    );

    expect(payload).toEqual({ text: '', files: [], failedFiles: ['a.jpg'] });
  });

  it('an unnamed failed copy keeps the placeholder name the gate shows', async () => {
    const payload = await normalizeShareIntent(
      {
        text: '',
        webUrl: null,
        meta: null,
        files: [
          {
            fileName: '',
            mimeType: 'image/jpeg',
            path: 'file:///share/unnamed',
            size: null,
            width: null,
            height: null,
            duration: null,
          },
        ],
      },
      async () => {
        await Promise.resolve();
        throw new Error('copy failed');
      }
    );

    expect(payload).toEqual({ text: '', files: [], failedFiles: ['shared-file'] });
  });
});
