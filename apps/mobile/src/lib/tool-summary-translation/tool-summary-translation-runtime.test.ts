import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as runtimeModule from './tool-summary-translation-runtime';

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
    const mod = await loadRuntime();
    requestMock.mockRejectedValue(new Error('gateway down'));

    mod.ensureTranslation({ text: 'broken summary', language: 'de', model: MODEL });
    await flush();

    expect(mod.getTranslation('broken summary', 'de', MODEL.id)).toBeUndefined();
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
});
