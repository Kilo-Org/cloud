/* eslint-disable require-await, @typescript-eslint/require-await -- the in-memory KV fake settles without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The translation cache stores through the encrypted-kv module; the mock below
// is an in-memory per-scope store with the real map semantics, keeping the
// native SQLCipher chain out of this node suite.
const kvMock = vi.hoisted(() => {
  const scopes = new Map<string, Map<string, { v: string; updatedAt: number }>>();
  let clock = 0;
  return {
    scopes,
    getItem: vi.fn<(scope: string, k: string) => Promise<string | null>>(
      async (scope, k) => scopes.get(scope)?.get(k)?.v ?? null
    ),
    setItem: vi.fn(async (scope: string, k: string, v: string) => {
      clock += 1;
      let bucket = scopes.get(scope);
      if (!bucket) {
        bucket = new Map();
        scopes.set(scope, bucket);
      }
      bucket.set(k, { v, updatedAt: clock });
    }),
    removeItem: vi.fn(async (scope: string, k: string) => {
      scopes.get(scope)?.delete(k);
    }),
    clearScope: vi.fn(async (scope: string) => {
      scopes.delete(scope);
    }),
    listEntries: vi.fn(async (scope: string) =>
      [...(scopes.get(scope)?.entries() ?? [])]
        .map(([k, entry]) => ({ k, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    ),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  clearScope: kvMock.clearScope,
  listEntries: kvMock.listEntries,
}));

/* eslint-disable import/first */
import { TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE } from '@/lib/storage-keys';
import {
  type CachedToolSummaryTranslation,
  clearToolSummaryTranslationsForSignOut,
  readToolSummaryTranslations,
  TOOL_SUMMARY_TRANSLATION_CACHE_CAP,
  TOOL_SUMMARY_TRANSLATION_CLEAR_TIMEOUT_MS,
  writeToolSummaryTranslation,
} from './tool-summary-translation-cache';
/* eslint-enable import/first */

const SCOPE = TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE;
const ITEM_KEY = 'tt:de:kilo-auto/small:item-1:Ran the tests';

function makeEntry(
  overrides: Partial<CachedToolSummaryTranslation> = {}
): CachedToolSummaryTranslation {
  return {
    itemId: 'item-1',
    language: 'de',
    modelId: 'kilo-auto/small',
    text: 'Ran the tests',
    translation: 'Tests ausgeführt',
    storedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function seed(entries: [string, string][]): void {
  kvMock.scopes.set(
    SCOPE,
    new Map(entries.map(([k, v], index) => [k, { v, updatedAt: index + 1 }]))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  kvMock.scopes.clear();
});

describe('tool summary translation cache', () => {
  it('round-trips an entry under its item id key', async () => {
    const entry = makeEntry();

    await writeToolSummaryTranslation(entry);

    await expect(readToolSummaryTranslations()).resolves.toEqual([entry]);
    expect(kvMock.setItem).toHaveBeenCalledWith(SCOPE, ITEM_KEY, JSON.stringify(entry));
  });

  it('reads an empty scope as no entries', async () => {
    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('drops malformed values and keeps the valid ones', async () => {
    seed([
      [ITEM_KEY, JSON.stringify(makeEntry())],
      ['tt:de:kilo-auto/small:item-not-json:not-json', 'not-json'],
      ['tt:de:kilo-auto/small:item-wrong-shape:shape', '{"itemId":"item-wrong-shape"}'],
      [
        'tt:de:kilo-auto/small:item-bad-time:time',
        JSON.stringify({ ...makeEntry(), itemId: 'item-bad-time', storedAt: null }),
      ],
    ]);

    await expect(readToolSummaryTranslations()).resolves.toEqual([makeEntry()]);
  });

  it('swallows a KV read failure', async () => {
    seed([[ITEM_KEY, JSON.stringify(makeEntry())]]);
    kvMock.getItem.mockRejectedValueOnce(new Error('kv down'));

    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('swallows a KV list failure', async () => {
    kvMock.listEntries.mockRejectedValueOnce(new Error('kv down'));

    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('swallows a KV write failure', async () => {
    kvMock.setItem.mockRejectedValueOnce(new Error('kv down'));

    await expect(writeToolSummaryTranslation(makeEntry())).resolves.toBeUndefined();
    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('ignores an entry that fails validation', async () => {
    await writeToolSummaryTranslation({ ...makeEntry(), storedAt: Number.NaN });

    expect(kvMock.setItem).not.toHaveBeenCalled();
    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('evicts the oldest entries beyond the cap and keeps the newest', async () => {
    const total = TOOL_SUMMARY_TRANSLATION_CACHE_CAP + 2;
    for (let index = 0; index < total; index += 1) {
      // Sequential writes keep `updated_at` strictly increasing so the evicted
      // entries are deterministic.
      // eslint-disable-next-line no-await-in-loop -- eviction order depends on write order.
      await writeToolSummaryTranslation(makeEntry({ itemId: `item-${index}` }));
    }

    const keys = [...(kvMock.scopes.get(SCOPE)?.keys() ?? [])];
    expect(keys).toHaveLength(TOOL_SUMMARY_TRANSLATION_CACHE_CAP);
    expect(keys).not.toContain('tt:de:kilo-auto/small:item-0:Ran the tests');
    expect(keys).not.toContain('tt:de:kilo-auto/small:item-1:Ran the tests');
    expect(keys).toContain(`tt:de:kilo-auto/small:item-${total - 1}:Ran the tests`);
  });

  it('keeps two entries apart that share the text but not the item id', async () => {
    await writeToolSummaryTranslation(makeEntry({ itemId: 'item-1' }));
    await writeToolSummaryTranslation(makeEntry({ itemId: 'item-2' }));

    const entries = await readToolSummaryTranslations();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.itemId).toSorted()).toEqual(['item-1', 'item-2']);
    expect(kvMock.setItem).toHaveBeenCalledWith(
      SCOPE,
      'tt:de:kilo-auto/small:item-1:Ran the tests',
      JSON.stringify(makeEntry({ itemId: 'item-1' }))
    );
    expect(kvMock.setItem).toHaveBeenCalledWith(
      SCOPE,
      'tt:de:kilo-auto/small:item-2:Ran the tests',
      JSON.stringify(makeEntry({ itemId: 'item-2' }))
    );
  });

  it('keeps two entries apart that share the item id but not the source text', async () => {
    // A part whose source string changed: the write for the old text must not
    // replace the current text's entry, or a cold-start offline row misses its
    // translation.
    await writeToolSummaryTranslation(makeEntry({ text: 'Previous summary', translation: 'Alt' }));
    await writeToolSummaryTranslation(makeEntry({ text: 'Current summary', translation: 'Neu' }));

    const entries = await readToolSummaryTranslations();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry.text).toSorted()).toEqual([
      'Current summary',
      'Previous summary',
    ]);

    // A late write for the old text leaves the current text's entry intact.
    await writeToolSummaryTranslation(makeEntry({ text: 'Previous summary', translation: 'Alt' }));
    const after = await readToolSummaryTranslations();
    const current = after.find(entry => entry.text === 'Current summary');
    expect(current?.translation).toBe('Neu');
  });

  it('sign-out clear drops the whole scope', async () => {
    await writeToolSummaryTranslation(makeEntry({ itemId: 'item-1' }));
    await writeToolSummaryTranslation(makeEntry({ itemId: 'item-2' }));

    await clearToolSummaryTranslationsForSignOut();

    expect(kvMock.clearScope).toHaveBeenCalledWith(SCOPE);
    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
  });

  it('clears a missing scope as a no-op', async () => {
    await expect(clearToolSummaryTranslationsForSignOut()).resolves.toBeUndefined();
    expect(kvMock.clearScope).toHaveBeenCalledWith(SCOPE);
  });

  it('swallows a KV clear failure so sign-out can continue', async () => {
    await writeToolSummaryTranslation(makeEntry());
    kvMock.clearScope.mockRejectedValueOnce(new Error('kv down'));

    await expect(clearToolSummaryTranslationsForSignOut()).resolves.toBeUndefined();
  });

  it('bounds the sign-out clear when the native clear never settles', async () => {
    // A native `openDatabase`/`clearScope` that never settles must not hold
    // sign-out teardown: the clear resolves its caller after the bound so the
    // query-client clear and the token reset that follow it still run.
    vi.useFakeTimers();
    try {
      const gate = Promise.withResolvers<undefined>();
      kvMock.clearScope.mockReturnValueOnce(gate.promise);

      let settled = false;
      const clear = (async () => {
        await clearToolSummaryTranslationsForSignOut();
        settled = true;
      })();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_CLEAR_TIMEOUT_MS + 1);
      await clear;
      expect(settled).toBe(true);

      gate.resolve(undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});
