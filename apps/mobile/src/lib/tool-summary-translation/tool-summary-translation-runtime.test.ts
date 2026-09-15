import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type * as runtimeModule from './tool-summary-translation-runtime';
import {
  TOOL_SUMMARY_TRANSLATION_RETRY_BASE_MS,
  TOOL_SUMMARY_TRANSLATION_RETRY_MAX_MS,
} from './tool-summary-translation-runtime';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslation: requestMock,
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

/** Two macrotask rounds let the dynamic import and the mocked request settle. */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flush(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(() => {
      setImmediate(resolve);
    });
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function loadRuntime(): Promise<typeof runtimeModule> {
  vi.resetModules();
  return import('./tool-summary-translation-runtime');
}

type TranslationRequest = { text: string; targetLanguage: string; model: string };

function requestCalls(): TranslationRequest[] {
  return (requestMock.mock.calls as [TranslationRequest][]).map(args => args[0]);
}

/**
 * Resolve the client module's dynamic import once before the batch: vitest's
 * module runner resolves concurrent imports of the same mocked module slowly
 * and nondeterministically, which would make the in-flight count flaky.
 */
async function warmClientImport(mod: typeof runtimeModule): Promise<void> {
  requestMock.mockResolvedValueOnce('warm');
  mod.ensureTranslation({ text: 'warmup', language: 'de', model: MODEL });
  await vi.waitFor(() => {
    expect(mod.getTranslation('warmup', 'de', MODEL.id)).toBe('warm');
  });
  requestMock.mockClear();
}

/**
 * Queue six items — more than MAX_CONCURRENT — so at least two are provably
 * still queued: items 0-3 occupy the four concurrency slots (even while
 * stuck on their lazy import), so items 4 and 5 cannot have started. Each
 * request stays pending until the test resolves it.
 */
function queueSixPendingRequests(mod: typeof runtimeModule): (() => void)[] {
  const resolveRequest: (() => void)[] = [];
  requestMock.mockImplementation(
    // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock returns a promise the test resolves later
    () =>
      new Promise<string>(resolve => {
        resolveRequest.push(() => {
          resolve('translated');
        });
      })
  );
  for (let i = 0; i < 6; i += 1) {
    mod.ensureTranslation({ text: `summary-${i}`, language: 'de', model: MODEL });
  }
  return resolveRequest;
}

/** Long enough for a slow mocked client import to hand its item to the gateway mock. */
async function quietPeriod(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 150);
  });
}

/** Resolve every request the mock has accepted so far, then let it settle. */
async function settleRequests(resolveRequest: (() => void)[]): Promise<void> {
  for (const resolve of resolveRequest.splice(0)) {
    resolve();
  }
  await quietPeriod();
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

  it('caches a resolved translation and bumps the version', async () => {
    const mod = await loadRuntime();
    requestMock.mockResolvedValue('übersetzt');
    const before = mod.getVersion();

    mod.ensureTranslation({ text: 'hello', language: 'de', model: MODEL });
    await flush();

    expect(requestMock).toHaveBeenCalledWith({
      text: 'hello',
      targetLanguage: 'de',
      model: 'kilo-auto/small',
    });
    expect(mod.getTranslation('hello', 'de', MODEL.id)).toBe('übersetzt');
    expect(mod.getVersion()).toBeGreaterThan(before);
  });

  it('leaves no translation before the request settles', async () => {
    const mod = await loadRuntime();
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock returns a pending promise the client resolves later
      () =>
        new Promise<string>(resolve => {
          setTimeout(() => {
            resolve('fertig');
          }, 10);
        })
    );

    mod.ensureTranslation({ text: 'pending summary', language: 'de', model: MODEL });
    expect(mod.getTranslation('pending summary', 'de', MODEL.id)).toBeUndefined();

    await vi.waitFor(() => {
      expect(mod.getTranslation('pending summary', 'de', MODEL.id)).toBe('fertig');
    });
  });

  it('does not cache a rejected translation and never throws', async () => {
    // The failure schedules a retry; fake timers keep that timer from firing
    // into a later test once this one is over.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));

    mod.ensureTranslation({ text: 'broken summary', language: 'de', model: MODEL });
    await flush();

    expect(mod.getTranslation('broken summary', 'de', MODEL.id)).toBeUndefined();
  });

  it('re-requests a summary whose request failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const mod = await loadRuntime();
    // One gateway hiccup, then a healthy answer.
    requestMock.mockRejectedValueOnce(new Error('gateway down')).mockResolvedValue('wieder');

    mod.ensureTranslation({ text: 'flaky summary', language: 'de', model: MODEL });
    await flush();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(mod.getTranslation('flaky summary', 'de', MODEL.id)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_RETRY_BASE_MS);
    await flush();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(mod.getTranslation('flaky summary', 'de', MODEL.id)).toBe('wieder');
  });

  it('drops a scheduled retry when the opt-in changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    requestMock.mockRejectedValueOnce(new Error('gateway down')).mockResolvedValue('spät');

    mod.ensureTranslation({ text: 'stale summary', language: 'de', model: MODEL });
    await flush();
    expect(requestMock).toHaveBeenCalledTimes(1);

    mod.setConfig({ enabled: false, model: MODEL });
    await vi.advanceTimersByTimeAsync(TOOL_SUMMARY_TRANSLATION_RETRY_MAX_MS * 4);
    await flush();

    // The retry belonged to the previous generation: the summary the user just
    // stopped translating is never sent again.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(mod.getTranslation('stale summary', 'de', MODEL.id)).toBeUndefined();
  });

  it('dedupes identical concurrent requests into one client call', async () => {
    const mod = await loadRuntime();
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      () =>
        new Promise<string>(resolve => {
          setTimeout(() => {
            resolve('same');
          }, 10);
        })
    );

    mod.ensureTranslation({ text: 'same summary', language: 'de', model: MODEL });
    mod.ensureTranslation({ text: 'same summary', language: 'de', model: MODEL });

    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(mod.getTranslation('same summary', 'de', MODEL.id)).toBe('same');
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('skips blank text', async () => {
    const mod = await loadRuntime();

    mod.ensureTranslation({ text: '   ', language: 'de', model: MODEL });
    await flush();

    expect(requestMock).not.toHaveBeenCalled();
  });

  it('drops queued work when the opt-in is disabled before the first request completes', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    await warmClientImport(mod);

    const resolveRequest = queueSixPendingRequests(mod);
    mod.setConfig({ enabled: false, model: MODEL });
    await settleRequests(resolveRequest);
    await settleRequests(resolveRequest);

    // The two queued summaries never reach the gateway: only the four items
    // holding the concurrency slots can be sent (vitest resolves the lazy
    // client imports one at a time, so fewer may start within the window).
    expect(requestCalls().length).toBeGreaterThanOrEqual(1);
    expect(requestCalls().length).toBeLessThanOrEqual(4);
    const texts = requestCalls().map(args => args.text);
    expect(texts).not.toContain('summary-4');
    expect(texts).not.toContain('summary-5');
    // And the in-flight results are discarded: they belong to a prior generation.
    for (let i = 0; i < 6; i += 1) {
      expect(mod.getTranslation(`summary-${i}`, 'de', MODEL.id)).toBeUndefined();
    }
  });

  it('drops queued work when the model changes before the first request completes', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    await warmClientImport(mod);

    const resolveRequest = queueSixPendingRequests(mod);
    const otherModel = { id: 'kilo-auto/frontier', name: 'Auto Frontier' };
    mod.setConfig({ enabled: true, model: otherModel });
    await settleRequests(resolveRequest);
    await settleRequests(resolveRequest);

    // No stale queued item is sent, and nothing from the old generation caches.
    expect(requestCalls().length).toBeGreaterThanOrEqual(1);
    expect(requestCalls().length).toBeLessThanOrEqual(4);
    expect(requestCalls().every(args => args.model === MODEL.id)).toBe(true);
    for (let i = 0; i < 6; i += 1) {
      expect(mod.getTranslation(`summary-${i}`, 'de', MODEL.id)).toBeUndefined();
    }

    // The runtime still works under the new generation: the discarded summary
    // is re-requested with the current model.
    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: otherModel });
    await vi.waitFor(() => {
      expect(requestCalls().some(args => args.model === otherModel.id)).toBe(true);
    });
    await settleRequests(resolveRequest);
    expect(mod.getTranslation('summary-0', 'de', otherModel.id)).toBe('translated');
  });

  it('re-requests a summary whose stale request is still in flight after a config change', async () => {
    const mod = await loadRuntime();
    mod.setConfig({ enabled: true, model: MODEL });
    await warmClientImport(mod);

    const resolveRequest: (() => void)[] = [];
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock returns a promise the test resolves later
      () =>
        new Promise<string>(resolve => {
          resolveRequest.push(() => {
            resolve('translated');
          });
        })
    );

    // One request for the key, left pending so it is still in flight.
    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(1);
    });

    // The opt-in goes off and back on: the key is unchanged, but the pending
    // request belongs to the previous generation and its result is discarded.
    mod.setConfig({ enabled: false, model: MODEL });
    mod.setConfig({ enabled: true, model: MODEL });

    // The row re-requests the same summary under the new generation. The stale
    // in-flight entry must not dedupe it away, or the row stays untranslated.
    mod.ensureTranslation({ text: 'summary-0', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledTimes(2);
    });

    // The stale call resolves first and is discarded without caching.
    const [staleResolve] = resolveRequest.splice(0, 1);
    staleResolve?.();
    await quietPeriod();
    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBeUndefined();

    // The current-generation call resolves and translates the row.
    await settleRequests(resolveRequest);
    expect(mod.getTranslation('summary-0', 'de', MODEL.id)).toBe('translated');
  });
});
