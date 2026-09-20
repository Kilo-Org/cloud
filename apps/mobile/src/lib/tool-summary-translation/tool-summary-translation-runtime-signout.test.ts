import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as runtimeModule from './tool-summary-translation-runtime';

/**
 * Sign-out teardown owns two robustness guarantees the transcript path never
 * exercises: it must not wait forever on a store write that hangs, and it must
 * not leave a rejected write tracked. The store module is mocked here (the
 * sibling suite mocks the cache below it) so a write can hang or reject — the
 * real `persistTranslation` swallows both and would hide the tracker's
 * contract.
 */

const { requestMock, readMock, persistMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  persistMock: vi.fn(),
}));

vi.mock('./tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
vi.mock('./tool-summary-translation-store', () => ({
  readStoredTranslations: readMock,
  persistTranslation: persistMock,
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

type BatchRequest = { texts: readonly string[]; targetLanguage: string; model: string };

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function loadRuntime(): Promise<typeof runtimeModule> {
  vi.resetModules();
  return import('./tool-summary-translation-runtime');
}

/** The mocked client echoes one translation per text of the batch. */
function echoBatch(): void {
  requestMock.mockImplementation(
    // eslint-disable-next-line typescript-eslint/require-await -- the mock answers the batch synchronously
    async ({ texts }: BatchRequest) => texts.map(text => `de:${text}`)
  );
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  persistMock.mockReset();
  readMock.mockResolvedValue([]);
  persistMock.mockResolvedValue(undefined);
  echoBatch();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tool summary translation sign-out teardown', () => {
  it('bounds the sign-out drain when a dispatched store write never settles', async () => {
    const mod = await loadRuntime();
    // A store write that never answers, as a hung native module would.
    const gate = Promise.withResolvers<undefined>();
    persistMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock hands back a promise that never settles
      () => gate.promise
    );

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(persistMock).toHaveBeenCalledTimes(1);
    });

    vi.useFakeTimers();
    let settled = false;
    const signOut = (async () => {
      await mod.clearToolSummaryTranslationMemoryForSignOut();
      settled = true;
    })();
    // The hanging write is still tracked, so the drain armed its bound.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(mod.TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS + 1);
    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });
    await signOut;

    gate.resolve(undefined);
  });

  it('forgets a write the drain abandoned, so a later sign-out arms no bound', async () => {
    const mod = await loadRuntime();
    // A store write that never answers, as a hung native module would.
    const gate = Promise.withResolvers<undefined>();
    persistMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/promise-function-async -- the mock hands back a promise that never settles
      () => gate.promise
    );

    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.waitFor(() => {
      expect(persistMock).toHaveBeenCalledTimes(1);
    });

    vi.useFakeTimers();
    const first = mod.clearToolSummaryTranslationMemoryForSignOut();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(mod.TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS + 1);
    await first;

    // The write was abandoned by the bound, so it must be forgotten: a later
    // sign-out with nothing genuinely pending arms no timer instead of waiting
    // the whole bound again on work the first sign-out already wrote off.
    const second = mod.clearToolSummaryTranslationMemoryForSignOut();
    expect(vi.getTimerCount()).toBe(0);
    await second;

    gate.resolve(undefined);
  });

  it('forgets a write older than the drain bound, so a hung store cannot grow the tracker', async () => {
    const mod = await loadRuntime();
    // The first write never answers, as a hung native module would; later ones
    // settle normally.
    const gate = Promise.withResolvers<undefined>();
    persistMock.mockReturnValueOnce(gate.promise);

    vi.useFakeTimers();
    mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
    await vi.advanceTimersByTimeAsync(50);
    expect(persistMock).toHaveBeenCalledTimes(1);

    // Past the bound: the hung write is one a sign-out drain would already have
    // abandoned, so dispatching the next write must forget it instead of
    // tracking it for the rest of the session.
    await vi.advanceTimersByTimeAsync(mod.TOOL_SUMMARY_TRANSLATION_SIGN_OUT_DRAIN_TIMEOUT_MS + 1);
    mod.ensureTranslation({ itemId: 'part-2', text: 'world', language: 'de', model: MODEL });
    await vi.advanceTimersByTimeAsync(50);
    expect(persistMock).toHaveBeenCalledTimes(2);

    // Nothing is genuinely pending any more, so the sign-out drains nothing: a
    // still-tracked hung write would arm the whole bound here.
    const signOut = mod.clearToolSummaryTranslationMemoryForSignOut();
    expect(vi.getTimerCount()).toBe(0);
    await signOut;

    gate.resolve(undefined);
  });

  it('forgets a rejected store write instead of leaving it pending', async () => {
    const mod = await loadRuntime();
    persistMock.mockRejectedValue(new Error('store write failed'));
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      mod.ensureTranslation({ itemId: 'part-1', text: 'hello', language: 'de', model: MODEL });
      await vi.waitFor(() => {
        expect(persistMock).toHaveBeenCalledTimes(1);
      });
      // Let the rejection settle: the tracker must swallow it, not surface it
      // as an unhandled rejection, and must forget the write.
      await new Promise(resolve => {
        setTimeout(resolve, 20);
      });
      expect(unhandled).toEqual([]);

      // A forgotten write leaves the drain with nothing to await, so it arms
      // no bound; a still-tracked rejected write would arm the one-second
      // timer. The drain runs synchronously up to its first await, so the
      // count is read before the sign-out promise settles.
      vi.useFakeTimers();
      const signOut = mod.clearToolSummaryTranslationMemoryForSignOut();
      expect(vi.getTimerCount()).toBe(0);
      await signOut;
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
