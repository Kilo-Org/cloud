/* eslint-disable max-lines -- one cohesive suite: batching, hydration, expiry, persistence and the generation-staleness cases share one mocked store and client */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as runtimeModule from './tool-summary-translation-runtime';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };
const OTHER_MODEL = { id: 'kilo-auto/frontier', name: 'Auto Frontier' };

type BatchRequest = { texts: readonly string[]; targetLanguage: string; model: string };
type StoreEntry = {
  itemId: string;
  language: string;
  modelId: string;
  text: string;
  translation: string;
  storedAt: number;
};

function storeEntry(input: {
  itemId: string;
  text: string;
  translation: string;
  storedAt?: number;
}): StoreEntry {
  return {
    language: 'de',
    modelId: MODEL.id,
    storedAt: Date.now(),
    ...input,
  };
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function loadRuntime(): Promise<typeof runtimeModule> {
  vi.resetModules();
  return import('./tool-summary-translation-runtime');
}

function requestCalls(): BatchRequest[] {
  return (requestMock.mock.calls as [BatchRequest][]).map(args => args[0]);
}

/** The mocked client echoes one translation per text of the batch. */
function echoBatch(): void {
  requestMock.mockImplementation(
    // eslint-disable-next-line typescript-eslint/require-await -- the mock answers the batch synchronously
    async ({ texts }: BatchRequest) => texts.map(text => `de:${text}`)
  );
}

/**
 * A client call that stays pending until the test resolves it, one resolver per
 * call. Used by the in-flight generation cases.
 */
function pendingBatches(): ((results: (string | null)[]) => void)[] {
  const resolvers: ((results: (string | null)[]) => void)[] = [];
  requestMock.mockImplementation(
    // eslint-disable-next-line typescript-eslint/require-await -- the mock hands back a promise the test resolves later
    async () =>
      new Promise<(string | null)[]>(resolve => {
        resolvers.push(resolve);
      })
  );
  return resolvers;
}

/** Longer than the 40 ms batch window plus the lazy client import. */
async function flushBatch(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 150);
  });
}

/** Wait until every item of the batch is cached under its own id. */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function waitForTranslations(
  mod: typeof runtimeModule,
  items: { itemId: string; text: string }[]
): Promise<void> {
  return vi.waitFor(
    () => {
      for (const { itemId, text } of items) {
        expect(mod.getTranslation(itemId, text, 'de', MODEL.id)).toBe(`de:${text}`);
      }
    },
    { timeout: 5000, interval: 20 }
  );
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
});

describe('tool summary translation runtime', () => {
  it('starts disabled with the Auto Small default model', async () => {
    const mod = await loadRuntime();

    expect(mod.getConfig()).toEqual({
      enabled: false,
      model: { id: 'kilo-auto/small', name: 'Auto Small' },
    });
  });

  it('batches ten summaries enqueued in one tick into ONE client call', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const texts = Array.from({ length: 10 }, (_unused, index) => `summary ${index}`);
    const items = texts.map((text, index) => ({ itemId: `part-${index}`, text }));

    for (const item of items) {
      mod.ensureTranslation({ ...item, language: 'de', model: MODEL });
    }
    await waitForTranslations(mod, items);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]).toEqual({
      texts,
      targetLanguage: 'de',
      model: MODEL.id,
    });
    // Every row caches its own result, not the batch's first entry.
    for (const { itemId, text } of items) {
      expect(mod.getTranslation(itemId, text, 'de', MODEL.id)).toBe(`de:${text}`);
    }
  });

  it('caches a resolved translation and bumps the version once per batch', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const before = mod.getVersion();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    expect(mod.getTranslation('part-1', 'hello', 'de', MODEL.id)).toBe('de:hello');
    expect(mod.getVersion()).toBeGreaterThan(before);
  });

  it('makes a second request for a summary enqueued after the window', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'first', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'first' }]);
    mod.ensureTranslation({ itemId: 'part-2', text: 'second', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-2', text: 'second' }]);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]).toEqual({
      texts: ['second'],
      targetLanguage: 'de',
      model: MODEL.id,
    });
  });

  it('carries the same item and text once in the batch', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'same summary', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-1', text: 'same summary', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'same summary' }]);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['same summary']);
    expect(mod.getTranslation('part-1', 'same summary', 'de', MODEL.id)).toBe('de:same summary');
  });

  it('sends a full batch of 20 distinct texts in one request', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const first = Array.from({ length: 20 }, (_unused, index) => `summary ${index}`);
    const items = first.map((text, index) => ({ itemId: `part-${index}`, text }));

    for (const item of items) {
      mod.ensureTranslation({ ...item, language: 'de', model: MODEL });
    }
    await waitForTranslations(mod, items);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toHaveLength(20);

    // A summary enqueued after that batch still goes out in its own request.
    mod.ensureTranslation({ itemId: 'part-20', text: 'summary 20', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-20', text: 'summary 20' }]);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]).toEqual({
      texts: ['summary 20'],
      targetLanguage: 'de',
      model: MODEL.id,
    });
  });

  it('does not cache a rejected batch and never throws', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));

    mod.ensureTranslation({
      itemId: 'part-1',
      text: 'broken summary',
      language: 'de',
      model: MODEL,
    });
    await flushBatch();

    expect(mod.getTranslation('part-1', 'broken summary', 'de', MODEL.id)).toBeUndefined();
  });

  it('keeps the original summaries when the batch resolves with nulls', async () => {
    const mod = await loadRuntime();
    requestMock.mockResolvedValue([null, null]);

    mod.ensureTranslation({ itemId: 'part-0', text: 'summary-0', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-1', language: 'de', model: MODEL });
    await flushBatch();

    expect(mod.getTranslation('part-0', 'summary-0', 'de', MODEL.id)).toBeUndefined();
    expect(mod.getTranslation('part-1', 'summary-1', 'de', MODEL.id)).toBeUndefined();
  });

  it('skips blank text', async () => {
    const mod = await loadRuntime();

    mod.ensureTranslation({ itemId: 'part-1', text: '   ', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('drops queued work when the opt-in is disabled before the window closes', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-0', language: 'de', model: MODEL });
    mod.setConfig({ enabled: false, model: MODEL });
    await flushBatch();

    // The queued summary was captured under the previous opt-in and never
    // reaches the gateway.
    expect(requestMock).not.toHaveBeenCalled();
    expect(mod.getTranslation('part-1', 'summary-0', 'de', MODEL.id)).toBeUndefined();
  });

  it('discards a batch that resolves after the model changed', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The model changes while the batch is in flight: its results belong to the
    // previous generation and must not cache.
    mod.setConfig({ enabled: true, model: OTHER_MODEL });
    resolvers[0]?.(['translated']);
    await flushBatch();

    expect(mod.getTranslation('part-1', 'summary-0', 'de', MODEL.id)).toBeUndefined();
    expect(requestCalls().every(call => call.model === MODEL.id)).toBe(true);
  });

  it('re-requests a summary whose stale batch is still in flight after a config change', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The opt-in goes off and back on: the key is unchanged, but the pending
    // batch belongs to the previous generation and its result is discarded.
    mod.setConfig({ enabled: false, model: MODEL });
    mod.setConfig({ enabled: true, model: MODEL });

    // The row re-requests the same summary under the new generation. The stale
    // in-flight entry must not dedupe it away, or the row stays untranslated.
    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    // The stale batch resolves first: it caches nothing, and its bookkeeping
    // must not delete the replacement's in-flight entry.
    resolvers[0]?.(['stale']);
    await flushBatch();
    expect(mod.getTranslation('part-1', 'summary-0', 'de', MODEL.id)).toBeUndefined();

    // The current-generation batch resolves and translates the row.
    resolvers[1]?.(['translated']);
    await vi.waitFor(() => {
      expect(mod.getTranslation('part-1', 'summary-0', 'de', MODEL.id)).toBe('translated');
    });
  });
});

describe('tool summary translation hydration', () => {
  it('serves a summary hydrated from the store with NO client call', async () => {
    readMock.mockResolvedValue([
      storeEntry({ itemId: 'part-1', text: 'Hello', translation: 'Hallo' }),
    ]);
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });

    await vi.waitFor(() => {
      expect(mod.getTranslation('part-1', 'Hello', 'de', MODEL.id)).toBe('Hallo');
    });

    mod.ensureTranslation({ itemId: 'part-1', text: 'Hello', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('holds the batch until hydration settles so a stored summary never requests', async () => {
    readMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/require-await -- the mock resolves the store read after the batch window
      async () =>
        new Promise<StoreEntry[]>(resolve => {
          setTimeout(() => {
            resolve([storeEntry({ itemId: 'part-1', text: 'Hello', translation: 'Hallo' })]);
          }, 80);
        })
    );
    const mod = await loadRuntime();

    // Enqueued before the 80 ms store read settles: a flush that dispatched at
    // the 40 ms window would make a request for a summary the store holds.
    mod.ensureTranslation({ itemId: 'part-1', text: 'Hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(mod.getTranslation('part-1', 'Hello', 'de', MODEL.id)).toBe('Hallo');
    });
    await flushBatch();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not serve an entry older than the TTL and re-requests it', async () => {
    const staleStoredAt = Date.now() - (2 * 24 * 60 * 60 * 1000 + 1000);
    readMock.mockResolvedValue([
      storeEntry({
        itemId: 'part-old',
        text: 'Old summary',
        translation: 'Alt',
        storedAt: staleStoredAt,
      }),
      // A fresh neighbour proves hydration has settled before we assert.
      storeEntry({ itemId: 'sentinel', text: 'Sentinel', translation: 'Wache' }),
    ]);
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });

    await vi.waitFor(() => {
      expect(mod.getTranslation('sentinel', 'Sentinel', 'de', MODEL.id)).toBe('Wache');
    });

    expect(mod.getTranslation('part-old', 'Old summary', 'de', MODEL.id)).toBeUndefined();

    echoBatch();
    mod.ensureTranslation({
      itemId: 'part-old',
      text: 'Old summary',
      language: 'de',
      model: MODEL,
    });
    await waitForTranslations(mod, [{ itemId: 'part-old', text: 'Old summary' }]);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['Old summary']);
    expect(mod.getTranslation('part-old', 'Old summary', 'de', MODEL.id)).toBe('de:Old summary');
  });

  it('does not serve an entry whose stored text differs from the requested text', async () => {
    readMock.mockResolvedValue([
      storeEntry({ itemId: 'part-x', text: 'Previous summary', translation: 'Alt' }),
      storeEntry({ itemId: 'sentinel', text: 'Sentinel', translation: 'Wache' }),
    ]);
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });

    await vi.waitFor(() => {
      expect(mod.getTranslation('sentinel', 'Sentinel', 'de', MODEL.id)).toBe('Wache');
    });

    expect(mod.getTranslation('part-x', 'New summary', 'de', MODEL.id)).toBeUndefined();

    echoBatch();
    mod.ensureTranslation({ itemId: 'part-x', text: 'New summary', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-x', text: 'New summary' }]);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['New summary']);
  });

  it('still translates when the store read fails', async () => {
    readMock.mockRejectedValue(new Error('kv unavailable'));
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'Hello', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'Hello' }]);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(mod.getTranslation('part-1', 'Hello', 'de', MODEL.id)).toBe('de:Hello');
  });

  it('writes one store entry per item with its own item id after a batch resolves', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-a', text: 'Alpha', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-b', text: 'Beta', language: 'de', model: MODEL });
    await waitForTranslations(mod, [
      { itemId: 'part-a', text: 'Alpha' },
      { itemId: 'part-b', text: 'Beta' },
    ]);

    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(2);
    });
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'part-a',
        language: 'de',
        modelId: MODEL.id,
        text: 'Alpha',
        translation: 'de:Alpha',
        storedAt: expect.any(Number),
      })
    );
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'part-b',
        language: 'de',
        modelId: MODEL.id,
        text: 'Beta',
        translation: 'de:Beta',
        storedAt: expect.any(Number),
      })
    );
  });

  it('makes one batch but two store entries for two ids with the same text', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-a', text: 'Same summary', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-b', text: 'Same summary', language: 'de', model: MODEL });
    await waitForTranslations(mod, [
      { itemId: 'part-a', text: 'Same summary' },
      { itemId: 'part-b', text: 'Same summary' },
    ]);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['Same summary']);

    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(2);
    });
    const writtenIds = writeMock.mock.calls
      .map(call => (call[0] as { itemId: string }).itemId)
      .toSorted();
    expect(writtenIds).toEqual(['part-a', 'part-b']);
  });
});
