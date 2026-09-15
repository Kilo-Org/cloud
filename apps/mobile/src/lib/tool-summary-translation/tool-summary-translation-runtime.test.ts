import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as runtimeModule from './tool-summary-translation-runtime';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };
const OTHER_MODEL = { id: 'kilo-auto/frontier', name: 'Auto Frontier' };

type BatchRequest = { texts: readonly string[]; targetLanguage: string; model: string };

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

/** Wait until every text of the batch is cached. */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function waitForTranslations(mod: typeof runtimeModule, texts: readonly string[]): Promise<void> {
  return vi.waitFor(
    () => {
      for (const text of texts) {
        expect(mod.getTranslation(text, 'de', MODEL.id)).toBe(`de:${text}`);
      }
    },
    { timeout: 5000, interval: 20 }
  );
}

beforeEach(() => {
  requestMock.mockReset();
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

    for (const text of texts) {
      mod.ensureTranslation({ text, language: 'de', model: MODEL });
    }
    await waitForTranslations(mod, texts);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]).toEqual({
      texts,
      targetLanguage: 'de',
      model: MODEL.id,
    });
    // Every row caches its own result, not the batch's first entry.
    for (const text of texts) {
      expect(mod.getTranslation(text, 'de', MODEL.id)).toBe(`de:${text}`);
    }
  });

  it('caches a resolved translation and bumps the version once per batch', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const before = mod.getVersion();

    mod.ensureTranslation({ text: 'hello', language: 'de', model: MODEL });
    await waitForTranslations(mod, ['hello']);

    expect(mod.getTranslation('hello', 'de', MODEL.id)).toBe('de:hello');
    expect(mod.getVersion()).toBeGreaterThan(before);
  });

  it('makes a second request for a summary enqueued after the window', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ text: 'first', language: 'de', model: MODEL });
    await waitForTranslations(mod, ['first']);
    mod.ensureTranslation({ text: 'second', language: 'de', model: MODEL });
    await waitForTranslations(mod, ['second']);

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestCalls()[1]).toEqual({
      texts: ['second'],
      targetLanguage: 'de',
      model: MODEL.id,
    });
  });

  it('carries the same text once in the batch', async () => {
    const mod = await loadRuntime();
    echoBatch();

    mod.ensureTranslation({ text: 'same summary', language: 'de', model: MODEL });
    mod.ensureTranslation({ text: 'same summary', language: 'de', model: MODEL });
    await waitForTranslations(mod, ['same summary']);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toEqual(['same summary']);
    expect(mod.getTranslation('same summary', 'de', MODEL.id)).toBe('de:same summary');
  });

  it('sends a full batch of 20 distinct texts in one request', async () => {
    const mod = await loadRuntime();
    echoBatch();
    const first = Array.from({ length: 20 }, (_unused, index) => `summary ${index}`);

    for (const text of first) {
      mod.ensureTranslation({ text, language: 'de', model: MODEL });
    }
    await waitForTranslations(mod, first);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestCalls()[0]?.texts).toHaveLength(20);

    // A summary enqueued after that batch still goes out in its own request.
    mod.ensureTranslation({ text: 'summary 20', language: 'de', model: MODEL });
    await waitForTranslations(mod, ['summary 20']);

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

    mod.ensureTranslation({ text: 'broken summary', language: 'de', model: MODEL });
    await flushBatch();

    expect(mod.getTranslation('broken summary', 'de', MODEL.id)).toBeUndefined();
  });

  it('keeps the original summaries when the batch resolves with nulls', async () => {
    const mod = await loadRuntime();
    requestMock.mockResolvedValue([null, null]);

    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    mod.ensureTranslation({ text: 'summary-1', language: 'de', model: MODEL });
    await flushBatch();

    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBeUndefined();
    expect(mod.getTranslation('summary-1', 'de', MODEL.id)).toBeUndefined();
  });

  it('skips blank text', async () => {
    const mod = await loadRuntime();

    mod.ensureTranslation({ text: '   ', language: 'de', model: MODEL });
    await flushBatch();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('drops queued work when the opt-in is disabled before the window closes', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    echoBatch();

    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    mod.setConfig({ enabled: false, model: MODEL });
    await flushBatch();

    // The queued summary was captured under the previous opt-in and never
    // reaches the gateway.
    expect(requestMock).not.toHaveBeenCalled();
    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBeUndefined();
  });

  it('discards a batch that resolves after the model changed', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    const resolvers = pendingBatches();

    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The model changes while the batch is in flight: its results belong to the
    // previous generation and must not cache.
    mod.setConfig({ enabled: true, model: OTHER_MODEL });
    resolvers[0]?.(['translated']);
    await flushBatch();

    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBeUndefined();
    expect(requestCalls().every(call => call.model === MODEL.id)).toBe(true);
  });

  it('re-requests a summary whose stale batch is still in flight after a config change', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    const resolvers = pendingBatches();

    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The opt-in goes off and back on: the key is unchanged, but the pending
    // batch belongs to the previous generation and its result is discarded.
    mod.setConfig({ enabled: false, model: MODEL });
    mod.setConfig({ enabled: true, model: MODEL });

    // The row re-requests the same summary under the new generation. The stale
    // in-flight entry must not dedupe it away, or the row stays untranslated.
    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    // The stale batch resolves first: it caches nothing, and its bookkeeping
    // must not delete the replacement's in-flight entry.
    resolvers[0]?.(['stale']);
    await flushBatch();
    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBeUndefined();

    // The current-generation batch resolves and translates the row.
    resolvers[1]?.(['translated']);
    await vi.waitFor(() => {
      expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBe('translated');
    });
  });
});
