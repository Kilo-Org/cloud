import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ModelPreferencesError } from '@/src/shared/model-preferences-client';
import {
  applyFavoriteToggle,
  applyFavoriteToggleCompletionUi,
  createSerialAsyncChain,
  deriveModelPreferencesStatus,
  isFavoriteToggleCompletionCurrent,
  reduceTerminalLatch,
  reduceToggleError,
  runOptimisticFavoriteToggle,
} from './model-preferences-state';

const queryKey = ['side-panel', 'model-preferences', 'token-1', 'personal'] as const;

const terminalError = new ModelPreferencesError('forbidden', {
  status: 403,
  trpcCode: 'FORBIDDEN',
});

const retryableError = new ModelPreferencesError('server error', {
  status: 500,
  trpcCode: null,
});

describe('favorite list toggle apply', () => {
  it('adds a missing id and removes an existing id', () => {
    expect(applyFavoriteToggle(['a'], 'b')).toStrictEqual(['a', 'b']);
    expect(applyFavoriteToggle(['a', 'b'], 'a')).toStrictEqual(['b']);
  });
});

describe('terminal latch transitions', () => {
  it('latches on terminal query or mutation errors only', () => {
    expect(reduceTerminalLatch(false, { classification: 'terminal', type: 'query-error' })).toBe(
      true
    );
    expect(reduceTerminalLatch(false, { classification: 'terminal', type: 'mutation-error' })).toBe(
      true
    );
    expect(reduceTerminalLatch(false, { classification: 'retryable', type: 'query-error' })).toBe(
      false
    );
    expect(reduceTerminalLatch(true, { classification: 'retryable', type: 'mutation-error' })).toBe(
      true
    );
  });

  it('clears on key change or successful get', () => {
    expect(reduceTerminalLatch(true, { type: 'key-changed' })).toBe(false);
    expect(reduceTerminalLatch(true, { type: 'query-success' })).toBe(false);
  });
});

describe('preferences status derivation', () => {
  it('prefers the terminal latch over loading and query errors', () => {
    expect(
      deriveModelPreferencesStatus({
        isError: true,
        isPending: true,
        queryErrorClassification: 'retryable',
        terminalLatched: true,
      })
    ).toBe('terminal');
  });

  it('reports loading only while the first fetch is pending', () => {
    expect(
      deriveModelPreferencesStatus({
        isError: false,
        isPending: true,
        queryErrorClassification: null,
        terminalLatched: false,
      })
    ).toBe('loading');
  });

  it('maps query errors to retryable or terminal', () => {
    expect(
      deriveModelPreferencesStatus({
        isError: true,
        isPending: false,
        queryErrorClassification: 'retryable',
        terminalLatched: false,
      })
    ).toBe('retryable');
    expect(
      deriveModelPreferencesStatus({
        isError: true,
        isPending: false,
        queryErrorClassification: 'terminal',
        terminalLatched: false,
      })
    ).toBe('terminal');
  });

  it('reports ready when data is present without error', () => {
    expect(
      deriveModelPreferencesStatus({
        isError: false,
        isPending: false,
        queryErrorClassification: null,
        terminalLatched: false,
      })
    ).toBe('ready');
  });
});

describe('toggle error flag', () => {
  it('sets the flag on failure and clears it on the next success', () => {
    expect(reduceToggleError(false, 'failure')).toBe(true);
    expect(reduceToggleError(true, 'success')).toBe(false);
    expect(reduceToggleError(false, 'success')).toBe(false);
  });
});

describe('serial async chain', () => {
  it('starts the second task only after the first settles', async () => {
    const chain = createSerialAsyncChain();
    const order: string[] = [];
    const gate = {
      release: (): void => {
        // Replaced when the first task starts.
      },
    };
    // eslint-disable-next-line promise/avoid-new -- test gate for serialization
    const firstGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });

    const first = chain.enqueue(async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return 'first';
    });
    const second = chain.enqueue(() => {
      order.push('second-start');
      order.push('second-end');
      return Promise.resolve('second');
    });

    expect(order).toStrictEqual(['first-start']);
    gate.release();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(order).toStrictEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });
});

describe('favorite toggle completion stale guard', () => {
  it('does not set terminal latch or toggle-error when the key changed mid-flight', () => {
    expect(isFavoriteToggleCompletionCurrent('key-a', 'key-a')).toBe(true);
    expect(isFavoriteToggleCompletionCurrent('key-a', 'key-b')).toBe(false);

    const stale = applyFavoriteToggleCompletionUi({
      activeKeyFingerprint: 'key-b',
      enqueuedKeyFingerprint: 'key-a',
      outcome: { classification: 'terminal', ok: false },
      ui: {
        terminalLatched: reduceTerminalLatch(false, { type: 'key-changed' }),
        toggleError: false,
      },
    });
    expect(stale).toStrictEqual({ applied: false, terminalLatched: false, toggleError: false });

    const current = applyFavoriteToggleCompletionUi({
      activeKeyFingerprint: 'key-a',
      enqueuedKeyFingerprint: 'key-a',
      outcome: { classification: 'terminal', ok: false },
      ui: { terminalLatched: false, toggleError: false },
    });
    expect(current).toStrictEqual({ applied: true, terminalLatched: true, toggleError: false });
  });

  it('does not start a post-key-change toggle until the prior key toggle settles', async () => {
    const chain = createSerialAsyncChain();
    const order: string[] = [];
    const gate = {
      release: (): void => {
        // Replaced when the first toggle starts.
      },
    };
    // eslint-disable-next-line promise/avoid-new -- test gate for cross-key serialization
    const priorInFlight = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    const priorToggle = chain.enqueue(async () => {
      order.push('key-a-start');
      await priorInFlight;
      order.push('key-a-end');
    });
    const nextToggle = chain.enqueue(() => {
      order.push('key-b-start', 'key-b-end');
      return Promise.resolve();
    });
    expect(order).toStrictEqual(['key-a-start']);
    gate.release();
    await priorToggle;
    await nextToggle;
    expect(order).toStrictEqual(['key-a-start', 'key-a-end', 'key-b-start', 'key-b-end']);
  });
});

describe('optimistic favorite toggle helper', () => {
  it('adds the id immediately and keeps the optimistic list after success', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKey, { favorites: ['a'] });
    let mutateCalls = 0;
    const mutate = (): Promise<void> => {
      mutateCalls += 1;
      return Promise.resolve();
    };

    const result = await runOptimisticFavoriteToggle({
      modelId: 'b',
      mutate,
      queryClient,
      queryKey: [...queryKey],
    });

    expect(result).toStrictEqual({ ok: true });
    expect(mutateCalls).toBe(1);
    expect(queryClient.getQueryData(queryKey)).toStrictEqual({ favorites: ['a', 'b'] });
  });

  it('removes the id immediately on toggle off', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKey, { favorites: ['a', 'b'] });

    await runOptimisticFavoriteToggle({
      modelId: 'a',
      mutate: () => Promise.resolve(),
      queryClient,
      queryKey: [...queryKey],
    });

    expect(queryClient.getQueryData(queryKey)).toStrictEqual({ favorites: ['b'] });
  });

  it('rolls back to the snapshot when the mutation fails', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKey, { favorites: ['a'] });
    let sawDuringMutate: unknown = null;

    const result = await runOptimisticFavoriteToggle({
      modelId: 'b',
      mutate: () => {
        sawDuringMutate = queryClient.getQueryData(queryKey);
        return Promise.reject(retryableError);
      },
      queryClient,
      queryKey: [...queryKey],
    });

    expect(sawDuringMutate).toStrictEqual({ favorites: ['a', 'b'] });
    expect(result).toStrictEqual({ error: retryableError, ok: false });
    expect(queryClient.getQueryData(queryKey)).toStrictEqual({ favorites: ['a'] });
  });

  it('returns the terminal mutation error without keeping the optimistic write', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKey, { favorites: [] });

    const result = await runOptimisticFavoriteToggle({
      modelId: 'a',
      mutate: () => Promise.reject(terminalError),
      queryClient,
      queryKey: [...queryKey],
    });

    expect(result).toStrictEqual({ error: terminalError, ok: false });
    expect(queryClient.getQueryData(queryKey)).toStrictEqual({ favorites: [] });
  });
});
