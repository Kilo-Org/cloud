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

vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  copyAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
  deleteAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
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
  });

  it('all copy failures with text present return a text-only payload', async () => {
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

    expect(payload).toEqual({ text: 'text survives', files: [] });
  });

  it('all copy failures without text throw', async () => {
    await expect(
      normalizeShareIntent(
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
      )
    ).rejects.toThrow('Failed to copy shared files');
  });
});
