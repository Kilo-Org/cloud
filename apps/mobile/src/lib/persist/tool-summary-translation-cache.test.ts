/* eslint-disable require-await, @typescript-eslint/require-await -- the in-memory KV fake settles without await */
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
    removeItemIfValue: vi.fn(async (scope: string, k: string, v: string) => {
      const bucket = scopes.get(scope);
      if (bucket?.get(k)?.v !== v) {
        return false;
      }
      bucket.delete(k);
      return true;
    }),
    clearScope: vi.fn(async (scope: string) => {
      scopes.delete(scope);
    }),
    listEntries: vi.fn(async (scope: string) =>
      [...(scopes.get(scope)?.entries() ?? [])]
        .map(([k, entry]) => ({ k, updatedAt: entry.updatedAt }))
        .sort((a, b) => a.updatedAt - b.updatedAt)
    ),
    listValues: vi.fn(async (scope: string) =>
      [...(scopes.get(scope)?.values() ?? [])]
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .map(entry => entry.v)
    ),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: kvMock.getItem,
  setItem: kvMock.setItem,
  removeItem: kvMock.removeItem,
  removeItemIfValue: kvMock.removeItemIfValue,
  clearScope: kvMock.clearScope,
  listEntries: kvMock.listEntries,
  listValues: kvMock.listValues,
}));

/* eslint-disable import/first */
import { bumpAuthEpoch, currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE } from '@/lib/storage-keys';
import {
  type CachedToolSummaryTranslation,
  clearToolSummaryTranslationsForSignOut,
  readToolSummaryTranslations,
  TOOL_SUMMARY_TRANSLATION_CACHE_CAP,
  TOOL_SUMMARY_TRANSLATION_SCOPE_CLEAR_TIMEOUT_MS,
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

  it('hydrates a full cache without per-entry native reads', async () => {
    const entries = Array.from({ length: TOOL_SUMMARY_TRANSLATION_CACHE_CAP }, (_, index) =>
      makeEntry({ itemId: `item-${index}` })
    );
    seed(entries.map(entry => [entry.itemId, JSON.stringify(entry)]));

    await expect(readToolSummaryTranslations()).resolves.toEqual(entries);
    expect(kvMock.getItem).not.toHaveBeenCalled();
    expect(kvMock.listValues).toHaveBeenCalledExactlyOnceWith(SCOPE);
  });

  it.each([{ language: 'fr' }, { modelId: 'other/model' }])(
    'keeps same-item translations distinct for %j',
    async variant => {
      const original = makeEntry();
      const changed = makeEntry(variant);
      await writeToolSummaryTranslation(original);
      await writeToolSummaryTranslation(changed);

      expect(kvMock.scopes.get(SCOPE)?.size).toBe(2);
      await expect(readToolSummaryTranslations()).resolves.toEqual([original, changed]);
    }
  );

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
    kvMock.listValues.mockRejectedValueOnce(new Error('kv down'));

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

  it('resolves the sign-out clear when the KV clear never settles', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    // A native clear that never answers, as a hung SQLCipher operation would.
    kvMock.clearScope.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- the mock hands back a promise that never settles
      () => new Promise<void>(() => undefined)
    );
    await writeToolSummaryTranslation(makeEntry());

    let settled = false;
    const clear = (async () => {
      await clearToolSummaryTranslationsForSignOut();
      settled = true;
    })();
    await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_SCOPE_CLEAR_TIMEOUT_MS + 1);
    await clear;

    expect(settled).toBe(true);
  });

  it('removes a write that lands after an auth transition cleared the scope', async () => {
    // A store write the sign-out drain would have abandoned: it is still in
    // flight when the scope is cleared, and lands afterwards.
    const gate = Promise.withResolvers<undefined>();
    kvMock.setItem.mockImplementationOnce(async (scope: string, k: string, v: string) => {
      await gate.promise;
      // The native write commits after the clear, as a slow SQLCipher write
      // would; without the fence the entry survives the clear.
      kvMock.scopes.set(scope, new Map([[k, { v, updatedAt: 1 }]]));
    });

    // `persistTranslation` captures the epoch at dispatch, before the store
    // module can load.
    const dispatchedEpoch = currentAuthEpoch();
    const write = writeToolSummaryTranslation(makeEntry({ itemId: 'item-late' }), dispatchedEpoch);

    // Sign-out (or a direct account switch) moves the epoch and clears the
    // scope while the write is still in flight.
    bumpAuthEpoch();
    await clearToolSummaryTranslationsForSignOut();

    gate.resolve(undefined);
    await write;

    // The late write must not have recreated the previous account's entry.
    await expect(readToolSummaryTranslations()).resolves.toEqual([]);
    expect(kvMock.removeItemIfValue).toHaveBeenCalledWith(
      SCOPE,
      'tt:de:kilo-auto/small:item-late:Ran the tests',
      JSON.stringify(makeEntry({ itemId: 'item-late' }))
    );
  });

  it('does not delete a newer same-key entry when the abandoned late write settles', async () => {
    // A store write the sign-out drain abandoned. Its value commits, but its
    // promise does not settle until the gate opens, so a newer write under the
    // current epoch can land on the same key in between.
    const gate = Promise.withResolvers<undefined>();
    kvMock.setItem.mockImplementationOnce(async (scope: string, k: string, v: string) => {
      let bucket = kvMock.scopes.get(scope);
      if (!bucket) {
        bucket = new Map();
        kvMock.scopes.set(scope, bucket);
      }
      bucket.set(k, { v, updatedAt: 1 });
      await gate.promise;
    });

    const dispatchedEpoch = currentAuthEpoch();
    const late = writeToolSummaryTranslation(makeEntry({ itemId: 'item-shared' }), dispatchedEpoch);

    // The epoch moves and the scope is cleared while the write is unsettled.
    bumpAuthEpoch();
    await clearToolSummaryTranslationsForSignOut();

    // The next account reopens the same part under the current epoch: the same
    // item id and text produce the same key.
    const newer = makeEntry({
      itemId: 'item-shared',
      translation: 'Neu',
      storedAt: 1_700_000_001_000,
    });
    await writeToolSummaryTranslation(newer);

    gate.resolve(undefined);
    await late;

    // The abandoned write must not delete the newer, valid entry.
    await expect(readToolSummaryTranslations()).resolves.toEqual([newer]);
  });

  it('keeps a write made under the current auth epoch', async () => {
    await writeToolSummaryTranslation(makeEntry({ itemId: 'item-current' }), currentAuthEpoch());

    await expect(readToolSummaryTranslations()).resolves.toEqual([
      makeEntry({ itemId: 'item-current' }),
    ]);
    expect(kvMock.removeItem).not.toHaveBeenCalled();
  });
});
