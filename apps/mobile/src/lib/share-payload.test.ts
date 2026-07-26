import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

describe('composeShareText', () => {
  it('returns trimmed text', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(composeShareText({ text: '  hello  ', webUrl: null, meta: null, files: null })).toBe(
      'hello'
    );
  });

  it('returns empty string when text is blank and no webUrl', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(composeShareText({ text: '   ', webUrl: null, meta: null, files: null })).toBe('');
  });

  it('falls back to webUrl when text is empty', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(
      composeShareText({
        text: '  ',
        webUrl: 'https://example.com',
        meta: null,
        files: null,
      })
    ).toBe('https://example.com');
  });

  it('prefers non-empty text over webUrl', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(
      composeShareText({
        text: 'body',
        webUrl: 'https://example.com',
        meta: null,
        files: null,
      })
    ).toBe('body');
  });

  it('prefixes title when base is non-empty and does not already contain it', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(
      composeShareText({
        text: 'https://example.com',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('Example\nhttps://example.com');
  });

  it('does not re-prefix title when base already contains it', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(
      composeShareText({
        text: 'Example page https://example.com',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('Example page https://example.com');
  });

  it('does not add title when base is empty', async () => {
    const { composeShareText } = await import('./share-payload');
    expect(
      composeShareText({
        text: '',
        webUrl: null,
        meta: { title: 'Example' },
        files: null,
      })
    ).toBe('');
  });

  it('clamps to SHARE_TEXT_MAX_CHARS last', async () => {
    const { composeShareText, SHARE_TEXT_MAX_CHARS } = await import('./share-payload');
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
  beforeEach(async () => {
    const { __resetSharePayloadStoreForTests } = await import('./share-payload');
    __resetSharePayloadStoreForTests();
    vi.clearAllMocks();
  });

  it('put returns unique ids', async () => {
    const { putSharePayload, peekSharePayload } = await import('./share-payload');
    const a = putSharePayload({ text: 'a', files: [] });
    const b = putSharePayload({ text: 'b', files: [] });
    expect(a).not.toBe(b);
    expect(peekSharePayload(a)?.text).toBe('a');
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('take is read-and-clear and returns null on second read or unknown id', async () => {
    const { putSharePayload, takeSharePayload } = await import('./share-payload');
    const id = putSharePayload({ text: 'once', files: [] });
    expect(takeSharePayload(id)).toEqual({ text: 'once', files: [] });
    expect(takeSharePayload(id)).toBeNull();
    expect(takeSharePayload('missing')).toBeNull();
  });

  it('peek does not consume', async () => {
    const { putSharePayload, peekSharePayload, takeSharePayload } = await import('./share-payload');
    const id = putSharePayload({ text: 'peek', files: [] });
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(takeSharePayload(id)?.text).toBe('peek');
  });

  it('clear is id-scoped', async () => {
    const { putSharePayload, clearSharePayload, peekSharePayload } =
      await import('./share-payload');
    const a = putSharePayload({ text: 'a', files: [] });
    const b = putSharePayload({ text: 'b', files: [] });
    clearSharePayload(a);
    expect(peekSharePayload(a)).toBeNull();
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('evicts oldest first beyond the cap', async () => {
    const { putSharePayload, peekSharePayload, SHARE_PAYLOAD_MAX_ENTRIES } =
      await import('./share-payload');
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
});

describe('normalizeShareIntent', () => {
  it('copies files into cache paths rather than keeping share-container URIs', async () => {
    const { normalizeShareIntent } = await import('./share-payload');
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
