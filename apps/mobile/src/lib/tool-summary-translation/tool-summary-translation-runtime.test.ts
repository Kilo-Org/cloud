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

  it('caches each resolved translation and bumps the version once per batch', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const before = mod.getVersion();
    const items = ['hello', 'goodbye', 'thanks'].map((text, index) => ({
      itemId: `part-${index}`,
      text,
    }));

    for (const item of items) {
      mod.ensureTranslation({ ...item, language: 'de', model: MODEL });
    }
    await waitForTranslations(mod, items);

    for (const { itemId, text } of items) {
      expect(mod.getTranslation(itemId, text, 'de', MODEL.id)).toBe(`de:${text}`);
    }
    // One notification for the whole resolved batch, not one per item: a
    // regression that bumped per resolved item would read `before + 3` here.
    expect(mod.getVersion()).toBe(before + 1);
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

  it('keeps the row label when a second surface resolves a different source', async () => {
    const mod = await loadRuntime();
    echoBatch();

    // The transcript row resolves its label first. Then the detail sheet asks
    // for a different source string under the same part id.
    mod.ensureTranslation({ itemId: 'p1', text: 'row label', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'p1', text: 'row label' }]);
    mod.ensureTranslation({ itemId: 'p1', text: 'sheet text', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'p1', text: 'sheet text' }]);

    // Each source owns its own entry: the second resolve must not evict the
    // first, so the row keeps its translated label.
    expect(mod.getTranslation('p1', 'row label', 'de', MODEL.id)).toBe('de:row label');
    expect(mod.getTranslation('p1', 'sheet text', 'de', MODEL.id)).toBe('de:sheet text');
  });

  it('requests a source that changes while its own batch is in flight', async () => {
    const mod = await loadRuntime();
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'p1', text: 'partial', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The source changes while the first batch is still in flight. It must be
    // queued on its own key instead of dropped by the in-flight guard.
    mod.ensureTranslation({ itemId: 'p1', text: 'final', language: 'de', model: MODEL });
    resolvers[0]?.(['translated-partial']);

    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
    expect(requestCalls()[1]?.texts).toEqual(['final']);
    resolvers[1]?.(['translated-final']);

    await vi.waitFor(() => {
      expect(mod.getTranslation('p1', 'final', 'de', MODEL.id)).toBe('translated-final');
    });
    expect(mod.getTranslation('p1', 'partial', 'de', MODEL.id)).toBe('translated-partial');
  });

  it('drops the queued copy when the source changes inside the batch window', async () => {
    const mod = await loadRuntime();
    echoBatch();

    // The row streams a partial label, then settles on its final text before
    // the 40 ms batch window closes. React runs the streaming effect's cleanup
    // (releasing the superseded text) before the settled effect: the queued
    // superseded copy must be dropped, so the request carries only the text
    // the row now renders.
    mod.ensureTranslation({ itemId: 'p1', text: 'partial', language: 'de', model: MODEL });
    mod.releaseTranslationInterest({ itemId: 'p1', text: 'partial', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'p1', text: 'final', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['final']);
    expect(mod.getTranslation('p1', 'final', 'de', MODEL.id)).toBe('de:final');
  });

  it('keeps a queued copy another mounted surface still asks for', async () => {
    const mod = await loadRuntime();
    echoBatch();

    // The row and the detail sheet render two source strings of one part side
    // by side: the second surface's ensure must not prune the first surface's
    // queued copy, and one batch carries and resolves both.
    mod.ensureTranslation({ itemId: 'p1', text: 'row text', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'p1', text: 'sheet text', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['row text', 'sheet text']);
    await waitForTranslations(mod, [
      { itemId: 'p1', text: 'row text' },
      { itemId: 'p1', text: 'sheet text' },
    ]);
  });

  it('drops a queued copy once the surface that asked for it releases it', async () => {
    const mod = await loadRuntime();
    echoBatch();

    // The sheet showed a streaming string, then unmounted before the batch
    // window closed; the row's own text settled meanwhile. With no surface
    // asking for the streaming string any more, the row's settled ensure
    // prunes the queued copy: the request carries only the settled text.
    mod.ensureTranslation({ itemId: 'p1', text: 'streaming', language: 'de', model: MODEL });
    mod.releaseTranslationInterest({
      itemId: 'p1',
      text: 'streaming',
      language: 'de',
      model: MODEL,
    });
    mod.ensureTranslation({ itemId: 'p1', text: 'settled', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['settled']);
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

  /**
   * Every unresolved row owns a retry timer, and each tick asks the runtime for
   * its summary again. A summary parked behind the batch window or the in-flight
   * cap is neither cached nor in flight, so a dedupe that knew only those two
   * states would stack another copy of it on every tick: the queue would grow
   * with the outage, and the copies would replay as extra store writes once a
   * slot freed. The queue must hold one entry per summary however often a row
   * asks.
   */
  it('keeps one queue entry per summary however often a waiting row retries', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    // No request settles while the queue is inspected: the two in-flight
    // batches stay busy and the other summaries wait behind them.
    const resolveRequest: ((value: (string | null)[]) => void)[] = [];
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock returns a promise the test resolves in its cleanup
      () =>
        new Promise<(string | null)[]>(resolve => {
          resolveRequest.push(resolve);
        })
    );
    const texts = Array.from({ length: 45 }, (_, index) => `outage summary ${index}`);
    const askAll = (): void => {
      for (const [index, text] of texts.entries()) {
        mod.ensureTranslation({
          itemId: `part-${index}`,
          text,
          language: 'de',
          model: MODEL,
        });
      }
    };

    askAll();
    await flushBatch();
    // The two batches carry 20 texts each; the other five wait in the queue.
    expect(mod.getQueueSize()).toBe(texts.length - 40);

    // Three retry cadences with the gateway still hanging: the waiting rows ask
    // again each time and must not stack a second copy of themselves.
    askAll();
    askAll();
    askAll();

    expect(mod.getQueueSize()).toBe(texts.length - 40);

    // Stop the runtime and settle the started requests: this mock is shared
    // with every other case in the file, so no run may outlive the test and
    // count its call there.
    mod.setConfig({ enabled: false, model: MODEL });
    for (const resolve of resolveRequest.splice(0)) {
      resolve([]);
    }
    await flushBatch();
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

  it('does not seed the cache from a store read that settles after an account reset', async () => {
    // Sign-out (or a direct account switch) can reset the memory while the
    // store read is still in flight. The entries that read returns belong to
    // the account the reset just dropped, so seeding them would repopulate the
    // cache the reset cleared.
    const gate = Promise.withResolvers<StoreEntry[]>();
    readMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock hands back a promise the test resolves later
      () => gate.promise
    );
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });

    mod.clearToolSummaryTranslationMemory();
    gate.resolve([storeEntry({ itemId: 'part-1', text: 'Hello', translation: 'Hallo' })]);
    await flushBatch();

    expect(mod.getTranslation('part-1', 'Hello', 'de', MODEL.id)).toBeUndefined();
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

  it('releases the flush when the store read never settles', async () => {
    // A native store read that never settles must not hold every translation:
    // the cache is an optimization, never a gate on the transcript.
    readMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/require-await -- the mock never settles, which is the scenario under test
      async () =>
        new Promise<StoreEntry[]>(() => {
          // Pending by design: the store read hangs.
        })
    );
    const mod = await loadRuntime();
    echoBatch();
    vi.useFakeTimers();
    try {
      mod.ensureTranslation({ itemId: 'part-1', text: 'Hello', language: 'de', model: MODEL });
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(requestMock).toHaveBeenCalledTimes(1);
      expect(requestCalls()[0]?.texts).toEqual(['Hello']);
    } finally {
      vi.useRealTimers();
    }
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
      }),
      // The auth epoch captured at dispatch, so a late write can remove itself
      // after a sign-out or direct-switch scope clear.
      expect.any(Number)
    );
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'part-b',
        language: 'de',
        modelId: MODEL.id,
        text: 'Beta',
        translation: 'de:Beta',
        storedAt: expect.any(Number),
      }),
      expect.any(Number)
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

describe('retry of unresolved summaries after a connection recovery', () => {
  it('re-queues a failed batch when retryUnresolvedTranslations runs', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValueOnce(new Error('gateway down'));
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await flushBatch();
    expect(mod.getTranslation('part-1', 'hello', 'de', MODEL.id)).toBeUndefined();

    mod.retryUnresolvedTranslations();
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    // The recovery went through the normal batch path: one request for the
    // failed summary, and the row now resolves from the cache.
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]?.texts).toEqual(['hello']);
  });

  it('re-queues only the positions whose entries came back null', async () => {
    const mod = await loadRuntime();
    requestMock.mockResolvedValueOnce(['de:Alpha', null]);
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-a', text: 'Alpha', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-b', text: 'Beta', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-a', text: 'Alpha' }]);
    expect(mod.getTranslation('part-b', 'Beta', 'de', MODEL.id)).toBeUndefined();

    mod.retryUnresolvedTranslations();
    await waitForTranslations(mod, [{ itemId: 'part-b', text: 'Beta' }]);

    expect(requestCalls().at(-1)?.texts).toEqual(['Beta']);
  });

  it('drops a part’s superseded source text from the retry memory', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));

    // The part streams a partial label, then settles on its final text: the
    // effect cleanup releases the streaming text before the settled effect.
    // Both batches fail while the gateway is unreachable.
    mod.ensureTranslation({ itemId: 'p1', text: 'partial summary', language: 'de', model: MODEL });
    await flushBatch();
    mod.releaseTranslationInterest({
      itemId: 'p1',
      text: 'partial summary',
      language: 'de',
      model: MODEL,
    });
    mod.ensureTranslation({ itemId: 'p1', text: 'final summary', language: 'de', model: MODEL });
    await flushBatch();

    // The reconnect retry must carry only the text the part now renders.
    mod.retryUnresolvedTranslations();
    await flushBatch();

    expect(requestCalls().at(-1)?.texts).toEqual(['final summary']);
  });

  it('drops a failed summary from the retry memory when its last surface unmounts', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));

    mod.ensureTranslation({
      itemId: 'part-1',
      text: 'unmounted summary',
      language: 'de',
      model: MODEL,
    });
    await flushBatch();
    expect(mod.getTranslation('part-1', 'unmounted summary', 'de', MODEL.id)).toBeUndefined();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The row unmounts: no surface asks for this summary any more. Its failed
    // entry must leave the retry memory, so a reconnect edge or deep link does
    // not re-send a summary no row shows.
    mod.releaseTranslationInterest({
      itemId: 'part-1',
      text: 'unmounted summary',
      language: 'de',
      model: MODEL,
    });
    mod.retryUnresolvedTranslations();
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('drops a failed summary from the queue when its last surface unmounts', async () => {
    const mod = await loadRuntime();
    // No request settles: the queued copy stays waiting for a slot.
    const resolvers = pendingBatches();

    for (const index of [0, 1]) {
      mod.ensureTranslation({
        itemId: `part-${index}`,
        text: `summary ${index}`,
        language: 'de',
        model: MODEL,
      });
    }
    await flushBatch();

    // The first waiters occupy both in-flight slots; add a third that stays in
    // the queue, then unmount it.
    mod.ensureTranslation({ itemId: 'part-2', text: 'summary 2', language: 'de', model: MODEL });
    expect(mod.getQueueSize()).toBe(1);

    mod.releaseTranslationInterest({
      itemId: 'part-2',
      text: 'summary 2',
      language: 'de',
      model: MODEL,
    });

    // The unmounted row's copy left the queue: nothing is waiting any more.
    expect(mod.getQueueSize()).toBe(0);

    mod.setConfig({ enabled: false, model: MODEL });
    for (const resolve of resolvers) {
      resolve([]);
    }
    await flushBatch();
  });

  it('keeps a failed summary another surface still asks for', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValueOnce(new Error('gateway down'));
    echoBatch();

    // Two surfaces (a row and the detail sheet) show the same summary.
    mod.ensureTranslation({ itemId: 'part-1', text: 'shared', language: 'de', model: MODEL });
    mod.ensureTranslation({ itemId: 'part-1', text: 'shared', language: 'de', model: MODEL });
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // One surface unmounts; the other still renders the summary, so the
    // reconnect retry must re-send it.
    mod.releaseTranslationInterest({
      itemId: 'part-1',
      text: 'shared',
      language: 'de',
      model: MODEL,
    });
    mod.retryUnresolvedTranslations();
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'shared' }]);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]?.texts).toEqual(['shared']);
  });

  it('makes no request on a retry when every summary already resolved', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    mod.retryUnresolvedTranslations();
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a request that is still in flight when the retry fires', async () => {
    const mod = await loadRuntime();
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    mod.retryUnresolvedTranslations();
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    resolvers[0]?.(['de:hello']);
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('re-sends a re-queued summary once the attempt it raced has settled', async () => {
    const mod = await loadRuntime();
    const resolvers = pendingBatches();

    // The gateway is unreachable: the row's first attempt stays pending.
    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // Connectivity returns while that attempt is still pending and the deep
    // link re-enters the mounted transcript: the retry re-queues the row.
    mod.retryUnresolvedTranslations();
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The pending attempt then fails. The re-queued summary must not be
    // dropped with it: it is requested again and the row resolves.
    echoBatch();
    resolvers[0]?.([null]);
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]?.texts).toEqual(['hello']);
  });

  it('keeps the retry memory when a mounted row’s tick re-asks during an in-flight attempt', async () => {
    const mod = await loadRuntime();
    // The gateway is unreachable: the row's attempt stays pending.
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The mounted row's 10 s retry tick releases its interest and re-asks on the
    // same key while the attempt is still in flight. The release must not leave
    // the key out of the retry memory: the re-ask early-returns on the in-flight
    // guard, so without remembering it again a reconnect while the attempt is
    // pending could no longer re-queue the row.
    mod.releaseTranslationInterest({
      itemId: 'part-1',
      text: 'hello',
      language: 'de',
      model: MODEL,
    });
    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });

    // Connectivity returns while that attempt is still pending: the retry
    // re-queues the row, held as owned rather than dispatched twice.
    mod.retryUnresolvedTranslations();
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The pending attempt then fails. The re-queued summary must survive it and
    // be requested again.
    echoBatch();
    resolvers[0]?.([null]);
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]?.texts).toEqual(['hello']);
  });

  it('does not re-send a superseded text once the raced attempt settles unresolved', async () => {
    const mod = await loadRuntime();
    const resolvers = pendingBatches();

    // The gateway is unreachable: the row's first attempt stays pending.
    mod.ensureTranslation({ itemId: 'part-1', text: 'partial', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // Connectivity returns while that attempt is pending: the retry re-queues
    // the row while its own attempt is still in flight.
    mod.retryUnresolvedTranslations();
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // The row's source text settles while the raced attempt is still pending:
    // its effect cleanup releases 'partial' and the settled effect requests
    // the replacement on its own key.
    mod.releaseTranslationInterest({
      itemId: 'part-1',
      text: 'partial',
      language: 'de',
      model: MODEL,
    });
    mod.ensureTranslation({ itemId: 'part-1', text: 'final', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2);
    });
    expect(requestCalls()[1]?.texts).toEqual(['final']);

    // The raced attempt settles unresolved. The superseded 'partial' copy the
    // retry left queued must not be dispatched by the next flush: no surface
    // renders it any more.
    echoBatch();
    resolvers[0]?.([null]);
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls().at(-1)?.texts).toEqual(['final']);
  });

  it('does not dispatch a superseded copy a retry left queued', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValueOnce(new Error('gateway down'));

    // The row's first attempt fails: 'partial' settles unresolved and stays
    // in the retry memory.
    mod.ensureTranslation({ itemId: 'p1', text: 'partial', language: 'de', model: MODEL });
    await flushBatch();
    expect(mod.getTranslation('p1', 'partial', 'de', MODEL.id)).toBeUndefined();

    // Connectivity returns and the deep link re-enters the mounted transcript:
    // the retry re-queues the row. Before the batch window closes, its source
    // text settles on the final value: the effect cleanup releases 'partial'
    // and the settled effect supersedes it, so no surface renders 'partial'
    // any more — the queued superseded copy must be dropped, not dispatched.
    mod.retryUnresolvedTranslations();
    echoBatch();
    mod.releaseTranslationInterest({
      itemId: 'p1',
      text: 'partial',
      language: 'de',
      model: MODEL,
    });
    mod.ensureTranslation({ itemId: 'p1', text: 'final', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]?.texts).toEqual(['final']);
    expect(mod.getTranslation('p1', 'final', 'de', MODEL.id)).toBe('de:final');
  });

  it('drops the retry memory when the configuration changes', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    requestMock.mockRejectedValueOnce(new Error('gateway down'));
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await flushBatch();

    // The user switches models: work remembered under the old one must never
    // reach the gateway again; the mounted row re-requests under the new model.
    mod.setConfig({ enabled: true, model: OTHER_MODEL });
    mod.retryUnresolvedTranslations();
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(mod.getTranslation('part-1', 'hello', 'de', OTHER_MODEL.id)).toBeUndefined();
  });

  it('drops the remembered summaries when the authenticated account changes', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValueOnce(new Error('gateway down'));
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await flushBatch();
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Sign-out or a direct account switch: the remembered summary carries the
    // previous account's tool text, so the next account's retry must not send
    // it to the gateway.
    mod.clearToolSummaryTranslationMemory();
    mod.retryUnresolvedTranslations();
    await flushBatch();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('drops the in-memory cache when the authenticated account changes', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await waitForTranslations(mod, [{ itemId: 'part-1', text: 'hello' }]);

    mod.clearToolSummaryTranslationMemory();

    expect(mod.getTranslation('part-1', 'hello', 'de', MODEL.id)).toBeUndefined();
  });

  it('discards a batch that resolves after the sign-out reset', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    const resolvers = pendingBatches();

    mod.ensureTranslation({ itemId: 'part-1', text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // Sign-out while the batch is in flight: its result belongs to the
    // signed-out account's generation, so it must neither cache nor reach the
    // store after the disk scope clear that follows.
    await mod.clearToolSummaryTranslationMemoryForSignOut();
    resolvers[0]?.(['translated']);
    await flushBatch();

    expect(mod.getTranslation('part-1', 'summary-0', 'de', MODEL.id)).toBeUndefined();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('settles a dispatched store write before the sign-out reset resolves', async () => {
    const mod = await loadRuntime();
    echoBatch();
    // Hold the store write open: the runtime persists fire-and-forget, so a
    // sign-out that cleared the disk scope without waiting for this write could
    // let the signed-out account's entry land after the scope is gone.
    const gate = Promise.withResolvers<null>();
    writeMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock hands back a promise the test resolves later
      () => gate.promise
    );

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    let settled = false;
    const signOut = (async () => {
      await mod.clearToolSummaryTranslationMemoryForSignOut();
      settled = true;
    })();
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve(null);
    await signOut;
    expect(settled).toBe(true);
  });

  it('caps the retry memory, evicting the oldest unresolved summaries', async () => {
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));
    const items = Array.from({ length: 201 }, (_unused, index) => ({
      itemId: `part-${index}`,
      text: `summary ${index}`,
    }));

    for (const item of items) {
      mod.ensureTranslation({ ...item, language: 'de', model: MODEL });
    }
    await vi.waitFor(
      () => {
        // 201 texts arrive in 11 batches of at most 20; all fail.
        expect(requestMock).toHaveBeenCalledTimes(11);
      },
      { timeout: 3000, interval: 20 }
    );

    mod.retryUnresolvedTranslations();
    await vi.waitFor(
      () => {
        // At most 200 entries are remembered, so the retry sends 10 batches.
        expect(requestMock).toHaveBeenCalledTimes(21);
      },
      { timeout: 3000, interval: 20 }
    );
    await flushBatch();
    const retried = requestCalls()
      .slice(11)
      .flatMap(call => call.texts);
    expect(retried).toHaveLength(200);
    expect(retried).not.toContain('summary 0');
    expect(retried).toContain('summary 200');
  });
});
