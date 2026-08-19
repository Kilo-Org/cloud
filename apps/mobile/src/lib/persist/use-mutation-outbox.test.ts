/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN hooks under vitest (node env, no jsdom) */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake outbox module factories settle without await */
/* eslint-disable max-lines -- the key-reuse, write-helper, load-gating, and key-preservation suites share one harness in this file */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type OutboxRow } from '@/lib/persist/mutation-outbox';
import { useMutationOutbox } from './use-mutation-outbox';

const identityMock = vi.hoisted<{
  value: { userId: string | undefined; isLoading: boolean };
}>(() => ({
  value: { userId: undefined, isLoading: false },
}));

const listOutboxRowsMock = vi.hoisted(() => vi.fn(async (): Promise<OutboxRow[] | null> => []));
const writeOutboxRowMock = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
const removeOutboxRowMock = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));

vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => identityMock.value,
}));

vi.mock('@/lib/persist/mutation-outbox', () => ({
  listOutboxRows: listOutboxRowsMock,
  writeOutboxRow: writeOutboxRowMock,
  removeOutboxRow: removeOutboxRowMock,
}));

type OutboxResult = ReturnType<typeof useMutationOutbox>;

function safeRetryRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    taxonomy: 'safe-retry',
    operationKey: 'op-key-1',
    fingerprint: 'fp-1',
    input: { prompt: 'hello' },
    ...overrides,
  };
}

function Harness({ resultRef }: { resultRef: { current: OutboxResult | null } }): null {
  const result = useMutationOutbox();
  resultRef.current = result;
  return null;
}

function mountOutbox(): {
  resultRef: { current: OutboxResult | null };
  rerender: () => void;
} {
  const resultRef: { current: OutboxResult | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness, { resultRef }));
  });
  return {
    resultRef,
    rerender: () => {
      act(() => {
        renderer?.update(createElement(Harness, { resultRef }));
      });
    },
  };
}

function requireResult(resultRef: { current: OutboxResult | null }): OutboxResult {
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useMutationOutbox did not run');
  }
  return result;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | undefined = undefined;
  const promise = new Promise<T>(resolve => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolveFn?.(value);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  identityMock.value = { userId: 'u1', isLoading: false };
  listOutboxRowsMock.mockResolvedValue([]);
  writeOutboxRowMock.mockResolvedValue(undefined);
  removeOutboxRowMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMutationOutbox key reuse', () => {
  it('reuses a stored safe-retry key for a matching fingerprint on launch', async () => {
    listOutboxRowsMock.mockResolvedValue([safeRetryRow({ fingerprint: 'fp-1' })]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    expect(requireResult(resultRef).getStoredOperationKey('fp-1')).toBe('op-key-1');
  });

  it('returns null for a fingerprint with no stored row', async () => {
    listOutboxRowsMock.mockResolvedValue([]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    expect(requireResult(resultRef).getStoredOperationKey('fp-1')).toBeNull();
  });

  it('never contributes a key from a reconcile-first row (no auto-replay)', async () => {
    listOutboxRowsMock.mockResolvedValue([
      safeRetryRow({ fingerprint: 'fp-1', taxonomy: 'reconcile-first' }),
    ]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    const result = requireResult(resultRef);
    expect(result.getStoredOperationKey('fp-1')).toBeNull();
    expect(result.needsReconcile).toEqual([
      safeRetryRow({ fingerprint: 'fp-1', taxonomy: 'reconcile-first' }),
    ]);
  });

  it('surfaces reconcile-first rows as needs-reconcile and excludes safe-retry rows', async () => {
    listOutboxRowsMock.mockResolvedValue([
      safeRetryRow({ fingerprint: 'fp-safe' }),
      safeRetryRow({ fingerprint: 'fp-reconcile', taxonomy: 'reconcile-first' }),
    ]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    const result = requireResult(resultRef);
    expect(result.needsReconcile.map(r => r.fingerprint)).toEqual(['fp-reconcile']);
  });
});

describe('useMutationOutbox write helpers', () => {
  it('writeSafeRetry forces the safe-retry taxonomy', async () => {
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeSafeRetry({
      operationKey: 'op-key-1',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'safe-retry',
      operationKey: 'op-key-1',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });
  });

  it('writeReconcileFirst forces the reconcile-first taxonomy and records the scope', async () => {
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeReconcileFirst({
      operationKey: 'op-key-1',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'reconcile-first',
      operationKey: 'op-key-1',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });
  });

  it('remove delegates to removeOutboxRow', async () => {
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).remove('fp-1');
    expect(removeOutboxRowMock).toHaveBeenCalledWith('u1', 'fp-1');
  });

  it('no-ops every write and remove when the userId is unknown', async () => {
    identityMock.value = { userId: undefined, isLoading: false };
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    const result = requireResult(resultRef);
    await result.writeSafeRetry({ operationKey: 'k', fingerprint: 'fp', input: null });
    await result.writeReconcileFirst({
      operationKey: 'k',
      fingerprint: 'fp',
      scope: 'personal',
      input: null,
    });
    await result.remove('fp');

    expect(writeOutboxRowMock).not.toHaveBeenCalled();
    expect(removeOutboxRowMock).not.toHaveBeenCalled();
  });
});

describe('useMutationOutbox load gating', () => {
  it('is not loaded until the launch load settles', async () => {
    const load = deferred<OutboxRow[]>();
    listOutboxRowsMock.mockImplementationOnce(async () => load.promise);
    const { resultRef } = mountOutbox();

    expect(requireResult(resultRef).loaded).toBe(false);

    await act(async () => {
      load.resolve([safeRetryRow({ fingerprint: 'fp-1' })]);
    });
    await flushMicrotasks();

    expect(requireResult(resultRef).loaded).toBe(true);
    expect(requireResult(resultRef).getStoredOperationKey('fp-1')).toBe('op-key-1');
  });

  it('whenLoaded resolves once the load settles, then the stored key is readable', async () => {
    const load = deferred<OutboxRow[]>();
    listOutboxRowsMock.mockImplementationOnce(async () => load.promise);
    const { resultRef } = mountOutbox();

    const result = requireResult(resultRef);
    const waiter = result.whenLoaded();

    await act(async () => {
      load.resolve([safeRetryRow({ fingerprint: 'fp-1' })]);
    });
    await flushMicrotasks();
    await waiter;

    expect(result.getStoredOperationKey('fp-1')).toBe('op-key-1');
  });

  it('reports a failed read instead of passing it off as no stored rows', async () => {
    listOutboxRowsMock.mockResolvedValue(null);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await expect(requireResult(resultRef).whenLoaded()).resolves.toBe(false);
  });

  it('re-reads the store on a whenLoaded retry after a failed read', async () => {
    listOutboxRowsMock.mockResolvedValue(null);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    const result = requireResult(resultRef);
    await expect(result.whenLoaded()).resolves.toBe(false);

    listOutboxRowsMock.mockResolvedValue([safeRetryRow({ fingerprint: 'fp-1' })]);
    await act(async () => {
      await expect(result.whenLoaded()).resolves.toBe(true);
    });

    expect(requireResult(resultRef).getStoredOperationKey('fp-1')).toBe('op-key-1');
  });

  it('never releases waiters on a superseded load (identity changed mid-load)', async () => {
    const staleLoad = deferred<OutboxRow[]>();
    listOutboxRowsMock.mockImplementationOnce(async () => staleLoad.promise);
    const { resultRef, rerender } = mountOutbox();

    // The identity flips before the first load settles, so its rows belong to
    // the previous user and must apply to nothing.
    const freshLoad = deferred<OutboxRow[]>();
    listOutboxRowsMock.mockImplementationOnce(async () => freshLoad.promise);
    identityMock.value = { userId: 'u2', isLoading: false };
    rerender();

    await act(async () => {
      staleLoad.resolve([safeRetryRow({ fingerprint: 'fp-stale' })]);
    });
    await flushMicrotasks();

    expect(requireResult(resultRef).loaded).toBe(false);
    expect(requireResult(resultRef).getStoredOperationKey('fp-stale')).toBeNull();

    await act(async () => {
      freshLoad.resolve([safeRetryRow({ fingerprint: 'fp-fresh' })]);
    });
    await flushMicrotasks();

    expect(requireResult(resultRef).loaded).toBe(true);
    expect(requireResult(resultRef).getStoredOperationKey('fp-fresh')).toBe('op-key-1');
  });

  it('is loaded immediately when the identity resolves to no user', async () => {
    identityMock.value = { userId: undefined, isLoading: false };
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    expect(requireResult(resultRef).loaded).toBe(true);
  });

  it('is not loaded while the identity is still resolving', async () => {
    identityMock.value = { userId: undefined, isLoading: true };
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    expect(requireResult(resultRef).loaded).toBe(false);
  });
});

describe('useMutationOutbox key preservation and reconcile list', () => {
  it('preserves a stored safe-retry key instead of overwriting it with a fresh key', async () => {
    listOutboxRowsMock.mockResolvedValue([
      safeRetryRow({ fingerprint: 'fp-1', operationKey: 'stored-key' }),
    ]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeSafeRetry({
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'safe-retry',
      operationKey: 'stored-key',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });
  });

  it('uses the passed key when no stored row exists', async () => {
    listOutboxRowsMock.mockResolvedValue([]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeSafeRetry({
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'safe-retry',
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      input: { prompt: 'hello' },
    });
  });

  it('writeReconcileFirst preserves a stored reconcile-first key instead of a fresh key', async () => {
    listOutboxRowsMock.mockResolvedValue([
      safeRetryRow({
        fingerprint: 'fp-1',
        taxonomy: 'reconcile-first',
        operationKey: 'stored-key',
        scope: 'personal',
      }),
    ]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeReconcileFirst({
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'reconcile-first',
      operationKey: 'stored-key',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });
  });

  it('writeReconcileFirst uses the passed key when no stored row exists', async () => {
    listOutboxRowsMock.mockResolvedValue([]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();

    await requireResult(resultRef).writeReconcileFirst({
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });

    expect(writeOutboxRowMock).toHaveBeenCalledWith('u1', {
      taxonomy: 'reconcile-first',
      operationKey: 'fresh-key',
      fingerprint: 'fp-1',
      scope: 'personal',
      input: { repoFullName: 'kilo/repo' },
    });
  });

  it('remove drops the row from needsReconcile', async () => {
    listOutboxRowsMock.mockResolvedValue([
      safeRetryRow({ fingerprint: 'fp-reconcile', taxonomy: 'reconcile-first' }),
    ]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();
    expect(requireResult(resultRef).needsReconcile.map(r => r.fingerprint)).toEqual([
      'fp-reconcile',
    ]);

    await act(async () => {
      await requireResult(resultRef).remove('fp-reconcile');
    });

    expect(requireResult(resultRef).needsReconcile).toEqual([]);
  });

  it('refresh re-reads the rows so a settled retry drops its card', async () => {
    listOutboxRowsMock.mockResolvedValueOnce([]);
    const { resultRef } = mountOutbox();
    await flushMicrotasks();
    expect(requireResult(resultRef).needsReconcile).toEqual([]);

    listOutboxRowsMock.mockResolvedValueOnce([
      safeRetryRow({ fingerprint: 'fp-reconcile', taxonomy: 'reconcile-first' }),
    ]);
    await act(async () => {
      requireResult(resultRef).refresh();
    });
    await flushMicrotasks();

    expect(requireResult(resultRef).needsReconcile.map(r => r.fingerprint)).toEqual([
      'fp-reconcile',
    ]);
  });
});
