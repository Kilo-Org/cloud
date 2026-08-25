/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- cohesive suite: pure helpers + store + durable persistence + normalize */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSharePayloadStoreForTests,
  __setCheckFileExistsForTests,
  __setDeleteCachedFileForTests,
  clearSharePayload,
  composeShareText,
  discardUnstoredSharePayload,
  normalizeShareIntent,
  peekSharePayload,
  persistSharePayloadsNow,
  putSharePayload,
  restoreSharePayloads,
  setSharePersistUserId,
  SHARE_PAYLOAD_MAX_ENTRIES,
  SHARE_TEXT_MAX_CHARS,
  takeSharePayload,
} from './share-payload';
import {
  flushDraft,
  isStringDraft,
  loadDraft,
  PENDING_SHARE_ID_DRAFT_KEY,
  saveDraft,
  SHARE_PAYLOADS_DRAFT_KEY,
} from '@/lib/persist/drafts';

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
  getInfoAsync: vi.fn(async () => ({ exists: true, isDirectory: false })),
}));

// The drafts module (lazy-required by share-payload) imports the native
// encrypted-kv chain; the fake below mirrors the real upsert/list semantics
// (same harness as drafts.test.ts).
const kvStore = vi.hoisted(
  () => new Map<string, { scope: string; k: string; v: string; updatedAt: number }>()
);
const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

let nextUpdatedAt = 1;

/** Drains pending microtasks and macrotasks so fire-and-forget async clears settle. */
async function drainAsync(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

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
    const a = putSharePayload({ text: 'a', files: [], failedFiles: [] });
    const b = putSharePayload({ text: 'b', files: [], failedFiles: [] });
    expect(a).not.toBe(b);
    expect(peekSharePayload(a)?.text).toBe('a');
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('take is read-and-clear and returns null on second read or unknown id', () => {
    const id = putSharePayload({ text: 'once', files: [], failedFiles: [] });
    expect(takeSharePayload(id)).toEqual({ text: 'once', files: [], failedFiles: [] });
    expect(takeSharePayload(id)).toBeNull();
    expect(takeSharePayload('missing')).toBeNull();
  });

  it('peek does not consume', () => {
    const id = putSharePayload({ text: 'peek', files: [], failedFiles: [] });
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(peekSharePayload(id)?.text).toBe('peek');
    expect(takeSharePayload(id)?.text).toBe('peek');
  });

  it('clear is id-scoped', () => {
    const a = putSharePayload({ text: 'a', files: [], failedFiles: [] });
    const b = putSharePayload({ text: 'b', files: [], failedFiles: [] });
    clearSharePayload(a);
    expect(peekSharePayload(a)).toBeNull();
    expect(peekSharePayload(b)?.text).toBe('b');
  });

  it('evicts oldest first beyond the cap', () => {
    const ids: string[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 2; i += 1) {
      ids.push(putSharePayload({ text: `t-${i}`, files: [], failedFiles: [] }));
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
        failedFiles: [],
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
        failedFiles: [],
      });
      for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES; i += 1) {
        putSharePayload({ text: `keep-${i}`, files: [], failedFiles: [] });
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
        failedFiles: [],
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
        failedFiles: [],
      });
      expect(takeSharePayload(id)?.files[0]?.uri).toBe('file:///cache/share-upload-me.bin');
      expect(peekSharePayload(id)).toBeNull();
      // Composer may still be uploading; clear after take must not delete uris.
      clearSharePayload(id);
      await Promise.resolve();
      expect(deleted).toEqual([]);
    });
  });

  it('discardUnstoredSharePayload deletes copied file uris', async () => {
    await withDeleteTracking(async deleted => {
      discardUnstoredSharePayload({
        text: 'never-stored',
        files: [
          { name: 'a.jpg', uri: 'file:///cache/share-a.jpg' },
          { name: 'b.png', uri: 'file:///cache/share-b.png' },
        ],
        failedFiles: ['lost.pdf'],
      });
      await vi.waitFor(() => {
        expect(deleted).toEqual(['file:///cache/share-a.jpg', 'file:///cache/share-b.png']);
      });
    });
  });

  it('discardUnstoredSharePayload is a no-op for empty files', async () => {
    await withDeleteTracking(async deleted => {
      discardUnstoredSharePayload({
        text: 'text-only',
        files: [],
        failedFiles: ['lost.pdf'],
      });
      await Promise.resolve();
      expect(deleted).toEqual([]);
    });
  });
});

describe('share payload durable persistence', () => {
  beforeEach(() => {
    __resetSharePayloadStoreForTests();
    vi.clearAllMocks();
    kvStore.clear();
    nextUpdatedAt = 1;
    kvMock.getItem.mockImplementation(
      async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
    );
    kvMock.setItem.mockImplementation(async (scope, k, v) => {
      kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
      nextUpdatedAt += 1;
    });
    kvMock.removeItem.mockImplementation(async (scope, k) => {
      kvStore.delete(storageKey(scope, k));
    });
    kvMock.listEntries.mockImplementation(async scope =>
      [...kvStore.values()]
        .filter(entry => entry.scope === scope)
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
    );
  });

  it('put then restore fills peek', async () => {
    setSharePersistUserId('u1');
    const id = putSharePayload({ text: 'hello', files: [], failedFiles: [] });
    await persistSharePayloadsNow();
    __resetSharePayloadStoreForTests();
    // simulate process death (clears memory)
    await restoreSharePayloads('u1');
    expect(peekSharePayload(id)?.text).toBe('hello');
  });

  it('take then restore returns null', async () => {
    setSharePersistUserId('u1');
    const id = putSharePayload({ text: 'consumed', files: [], failedFiles: [] });
    await persistSharePayloadsNow();
    expect(takeSharePayload(id)?.text).toBe('consumed');
    await persistSharePayloadsNow();
    __resetSharePayloadStoreForTests();
    await restoreSharePayloads('u1');
    expect(peekSharePayload(id)).toBeNull();
  });

  it('clear then restore returns null', async () => {
    setSharePersistUserId('u1');
    const id = putSharePayload({ text: 'abandoned', files: [], failedFiles: [] });
    await persistSharePayloadsNow();
    clearSharePayload(id);
    await persistSharePayloadsNow();
    __resetSharePayloadStoreForTests();
    await restoreSharePayloads('u1');
    expect(peekSharePayload(id)).toBeNull();
  });

  it('evict beyond cap then restore lacks the oldest id', async () => {
    setSharePersistUserId('u1');
    const ids: string[] = [];
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 2; i += 1) {
      ids.push(putSharePayload({ text: `t-${i}`, files: [], failedFiles: [] }));
    }
    await persistSharePayloadsNow();
    __resetSharePayloadStoreForTests();
    await restoreSharePayloads('u1');
    expect(peekSharePayload(ids[0] ?? '')).toBeNull();
    expect(peekSharePayload(ids[1] ?? '')).toBeNull();
    expect(peekSharePayload(ids.at(-1) ?? '')?.text).toBe(`t-${SHARE_PAYLOAD_MAX_ENTRIES + 1}`);
  });

  it('moves a restored file whose uri is missing into failedFiles', async () => {
    setSharePersistUserId('u1');
    const id = putSharePayload({
      text: 'with-files',
      files: [
        { name: 'present.jpg', uri: 'file:///cache/present.jpg' },
        { name: 'gone.png', uri: 'file:///cache/gone.png' },
      ],
      failedFiles: [],
    });
    await persistSharePayloadsNow();
    __resetSharePayloadStoreForTests();
    __setCheckFileExistsForTests(async uri => uri.includes('present'));
    await restoreSharePayloads('u1');
    const restored = peekSharePayload(id);
    expect(restored?.files.map(file => file.name)).toEqual(['present.jpg']);
    expect(restored?.failedFiles).toEqual(['gone.png']);
  });

  it('skips persistence while userId is empty', async () => {
    const id = putSharePayload({ text: 'signed-out', files: [], failedFiles: [] });
    expect(peekSharePayload(id)?.text).toBe('signed-out');
    await persistSharePayloadsNow();
    expect(kvMock.setItem).not.toHaveBeenCalled();
    __resetSharePayloadStoreForTests();
    await restoreSharePayloads('u1');
    expect(peekSharePayload(id)).toBeNull();
  });

  it('a put landing during the restore read wins over the draft', async () => {
    setSharePersistUserId('u1');
    saveDraft('u1', SHARE_PAYLOADS_DRAFT_KEY, {
      order: ['draft-id'],
      entries: { 'draft-id': { text: 'draft-text', files: [], failedFiles: [] } },
    });
    await flushDraft('u1', SHARE_PAYLOADS_DRAFT_KEY);

    // Simulate process death: wipe the in-memory store, keep the draft.
    __resetSharePayloadStoreForTests();
    setSharePersistUserId('u1');

    // Start the restore; it suspends on the async draft read, so a put made
    // synchronously here runs during the read and must survive the fill.
    const restore = restoreSharePayloads('u1');
    const liveId = putSharePayload({ text: 'live', files: [], failedFiles: [] });

    await restore;

    expect(peekSharePayload(liveId)?.text).toBe('live');
  });

  it('restore of a truthy empty post-take draft does not clobber a live in-process payload', async () => {
    // u1 took their only share; the take persisted a truthy empty draft.
    setSharePersistUserId('u1');
    saveDraft('u1', SHARE_PAYLOADS_DRAFT_KEY, { order: [], entries: {} });
    await flushDraft('u1', SHARE_PAYLOADS_DRAFT_KEY);

    // Sign out; a signed-out share lands in memory only (persist no-ops).
    setSharePersistUserId(null);
    const liveId = putSharePayload({ text: 'live', files: [], failedFiles: [] });

    // Same-process login restores u1's empty draft.
    setSharePersistUserId('u1');
    await restoreSharePayloads('u1');

    expect(peekSharePayload(liveId)?.text).toBe('live');
  });

  it('restore for a different user does not eject a live payload', async () => {
    setSharePersistUserId('userA');
    const liveId = putSharePayload({ text: 'live-a', files: [], failedFiles: [] });
    await persistSharePayloadsNow();

    saveDraft('userB', SHARE_PAYLOADS_DRAFT_KEY, {
      order: ['draft-b'],
      entries: { 'draft-b': { text: 'draft-b-text', files: [], failedFiles: [] } },
    });
    await flushDraft('userB', SHARE_PAYLOADS_DRAFT_KEY);

    await restoreSharePayloads('userB');

    expect(peekSharePayload(liveId)?.text).toBe('live-a');
  });

  it('clearing one share never drops a different share pending id', async () => {
    setSharePersistUserId('u1');
    const a = putSharePayload({ text: 'a', files: [], failedFiles: [] });
    const b = putSharePayload({ text: 'b', files: [], failedFiles: [] });
    await persistSharePayloadsNow();

    // Persist the still-live share B as the pending id.
    saveDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, b);
    await flushDraft('u1', PENDING_SHARE_ID_DRAFT_KEY);

    clearSharePayload(a);
    await drainAsync();
    expect(await loadDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, isStringDraft)).toBe(b);

    clearSharePayload(b);
    await vi.waitFor(async () => {
      expect(await loadDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, isStringDraft)).toBeNull();
    });
  });

  it('taking one share never drops a different share pending id', async () => {
    setSharePersistUserId('u1');
    const a = putSharePayload({ text: 'a', files: [], failedFiles: [] });
    const b = putSharePayload({ text: 'b', files: [], failedFiles: [] });
    await persistSharePayloadsNow();

    saveDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, b);
    await flushDraft('u1', PENDING_SHARE_ID_DRAFT_KEY);

    expect(takeSharePayload(a)?.text).toBe('a');
    await drainAsync();
    expect(await loadDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, isStringDraft)).toBe(b);

    expect(takeSharePayload(b)?.text).toBe('b');
    await vi.waitFor(async () => {
      expect(await loadDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, isStringDraft)).toBeNull();
    });
  });

  it('clearing a superseded id cannot delete a newer pending id that is not yet flushed', async () => {
    setSharePersistUserId('u1');
    const a = putSharePayload({ text: 'a', files: [], failedFiles: [] });
    const b = putSharePayload({ text: 'b', files: [], failedFiles: [] });

    // a is the durable pending id; b is then saved but left unflushed so the
    // clear and the newer write overlap (the ordering the prior fix missed).
    saveDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, a);
    await flushDraft('u1', PENDING_SHARE_ID_DRAFT_KEY);
    saveDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, b);

    // Clearing the superseded a while b's write is still in flight leaves b.
    clearSharePayload(a);
    void flushDraft('u1', PENDING_SHARE_ID_DRAFT_KEY);

    await vi.waitFor(async () => {
      expect(await loadDraft('u1', PENDING_SHARE_ID_DRAFT_KEY, isStringDraft)).toBe(b);
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
    expect(payload.failedFiles).toEqual([]);
    const file = payload.files[0];
    expect(file).toBeDefined();
    expect(file?.uri).not.toBe(incoming);
    expect(file?.uri.includes('cache')).toBe(true);
  });
});
