import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharePayloadStoreForTests,
  __setDeleteCachedFileForTests,
  clearSharePayload,
  composeShareText,
  normalizeShareIntent,
  peekSharePayload,
  putSharePayload,
  SHARE_PAYLOAD_MAX_ENTRIES,
  SHARE_TEXT_MAX_CHARS,
  takeSharePayload,
} from './share-payload';

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

async function withDeleteTracking(run: (deleted: string[]) => Promise<void>): Promise<void> {
  const deleted: string[] = [];
  __setDeleteCachedFileForTests(async uri => {
    deleted.push(uri);
    await Promise.resolve();
  });
  try {
    await run(deleted);
  } finally {
    __resetSharePayloadStoreForTests();
  }
}

describe('composeShareText', () => {
  it('returns trimmed text', () => {
    expect(composeShareText({ text: '  hello  ', webUrl: null, meta: null, files: null })).toBe(
      'hello'
    );
  });

  it('returns empty string when text is blank and no webUrl', () => {
    expect(composeShareText({ text: '   ', webUrl: null, meta: null, files: null })).toBe('');
  });

  it('falls back to webUrl when text is empty', () => {
    expect(
      composeShareText({
        text: '  ',
        webUrl: 'https://example.com',
        meta: null,
        files: null,
      })
    ).toBe('https://example.com');
  });

  it('prefers non-empty text over webUrl', () => {
    expect(
      composeShareText({
        text: 'body',
        webUrl: 'https://example.com',
        meta: null,
        files: null,
      })
    ).toBe('body');
  });

  it('prefixes title when base is non-empty and does not already contain it', () => {
    expect(
      composeShareText({
        text: 'https://example.com',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('Example\nhttps://example.com');
  });

  it('does not re-prefix title when base already contains it', () => {
    expect(
      composeShareText({
        text: 'Example page https://example.com',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('Example page https://example.com');
  });

  it('does not add title when base is empty', () => {
    expect(
      composeShareText({
        text: '',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('');
  });

  it('clamps to SHARE_TEXT_MAX_CHARS last', () => {
    const long = 'a'.repeat(SHARE_TEXT_MAX_CHARS + 50);
    const composed = composeShareText({
      text: long,
      webUrl: null,
      meta: { title: 'T' },
      files: null,
    });
    expect(composed.length).toBe(SHARE_TEXT_MAX_CHARS);
    expect(composed.startsWith('T\n')).toBe(true);
  });
});

describe('share payload store', () => {
  beforeEach(() => {
    __resetSharePayloadStoreForTests();
    vi.clearAllMocks();
  });

  it('put returns unique ids', () => {
    const a = putSharePayload({ text: 'a', files: [] });
    const b = putSharePayload({ text: 'b', files: [] });
    expect(a).not.toBe(b);
    expect(peekSharePayload(a)?.text).toBe('a');
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('take is read-and-clear and returns null on second read or unknown id', () => {
    const id = putSharePayload({ text: 'once', files: [] });
    expect(takeSharePayload(id)).toEqual({ text: 'once', files: [] });
    expect(takeSharePayload(id)).toBeNull();
    expect(takeSharePayload('missing')).toBeNull();
  });

  it('peek does not consume', () => {
    const id = putSharePayload({ text: 'peek', files: [] });
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(takeSharePayload(id)?.text).toBe('peek');
  });

  it('clear is id-scoped', () => {
    const a = putSharePayload({ text: 'a', files: [] });
    const b = putSharePayload({ text: 'b', files: [] });
    clearSharePayload(a);
    expect(peekSharePayload(a)).toBeNull();
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('evicts oldest first beyond the cap', () => {
    const ids: string[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 2; i += 1) {
      ids.push(putSharePayload({ text: `t-${i}`, files: [] }));
    }
    const first = ids[0];
    const second = ids[1];
    const third = ids[2];
    const last = ids.at(-1);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(last).toBeDefined();
    expect(peekSharePayload(first ?? '')).toBeNull();
    expect(peekSharePayload(second ?? '')).toBeNull();
    expect(peekSharePayload(third ?? '')?.text).toBe('t-2');
    expect(peekSharePayload(last ?? '')?.text).toBe(`t-${SHARE_PAYLOAD_MAX_ENTRIES + 1}`);
  });

  it('clear deletes the payload file uris', async () => {
    await withDeleteTracking(async deleted => {
      const id = putSharePayload({
        text: 'with-files',
        files: [
          { name: 'a.jpg', uri: 'file:///cache/share-a.jpg' },
          { name: 'b.png', uri: 'file:///cache/share-b.png' },
        ],
      });
      clearSharePayload(id);
      await vi.waitFor(() => {
        expect(deleted).toEqual(['file:///cache/share-a.jpg', 'file:///cache/share-b.png']);
      });
    });
  });

  it('eviction of the oldest entry deletes that entry file uris', async () => {
    await withDeleteTracking(async deleted => {
      putSharePayload({
        text: 'oldest',
        files: [{ name: 'old.txt', uri: 'file:///cache/share-old.txt' }],
      });
      for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES; i += 1) {
        putSharePayload({ text: `keep-${i}`, files: [] });
      }
      await vi.waitFor(() => {
        expect(deleted).toEqual(['file:///cache/share-old.txt']);
      });
    });
  });

  it('take does not delete cache file uris', async () => {
    await withDeleteTracking(async deleted => {
      const id = putSharePayload({
        text: 'take-me',
        files: [{ name: 'kept.bin', uri: 'file:///cache/share-kept.bin' }],
      });
      expect(takeSharePayload(id)?.files[0]?.uri).toBe('file:///cache/share-kept.bin');
      await Promise.resolve();
      expect(deleted).toEqual([]);
    });
  });

  it('clear after take is a no-op and does not delete cache uris', async () => {
    await withDeleteTracking(async deleted => {
      const id = putSharePayload({
        text: 'taken-then-cleared',
        files: [{ name: 'upload-me.bin', uri: 'file:///cache/share-upload-me.bin' }],
      });
      expect(takeSharePayload(id)?.files[0]?.uri).toBe('file:///cache/share-upload-me.bin');
      expect(peekSharePayload(id)).toBeNull();
      // Composer may still be uploading; clear after take must not delete uris.
      clearSharePayload(id);
      await Promise.resolve();
      expect(deleted).toEqual([]);
    });
  });
});

describe('normalizeShareIntent', () => {
  it('copies files into cache paths rather than keeping share-container URIs', async () => {
    const incoming = 'file:///share-container/photo.jpg';
    const payload = await normalizeShareIntent(
      {
        text: null,
        webUrl: null,
        meta: null,
        files: [
          {
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            path: incoming,
            size: 12,
            width: null,
            height: null,
            duration: null,
          },
        ],
      },
      async ({ from, fileName }) => {
        expect(from).toBe(incoming);
        await Promise.resolve();
        return `file:///cache/copied-${fileName}`;
      }
    );

    expect(payload.files).toEqual([
      {
        name: 'photo.jpg',
        uri: 'file:///cache/copied-photo.jpg',
        mimeType: 'image/jpeg',
        size: 12,
      },
    ]);
    const file = payload.files[0];
    expect(file).toBeDefined();
    expect(file?.uri).not.toBe(incoming);
    expect(file?.uri.includes('cache')).toBe(true);
  });
});
