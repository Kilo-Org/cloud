import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { type PausedReadRetry, retryPausedRead, usePausedReadRetry } from './retry-paused-read';

describe('retryPausedRead', () => {
  it('cancels the paused query first, then refetches it forced and raw keyed', async () => {
    const queryClient = new QueryClient();
    const queryKey = ['securityAgent', 'getConfig'] as const;
    const data = { autoAnalysisEnabled: true };
    queryClient.setQueryData(queryKey, data);
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries').mockResolvedValue(undefined);
    const querySpy = vi.spyOn(queryClient, 'query').mockResolvedValue(data);

    await retryPausedRead(queryClient, queryKey);

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledOnce();
    const cancelOrder = cancelSpy.mock.invocationCallOrder[0];
    const queryOrder = querySpy.mock.invocationCallOrder[0];
    if (cancelOrder === undefined || queryOrder === undefined) {
      throw new Error('cancelQueries and query must each run once');
    }
    // Order is the fix: the cancel must retire the paused promise before the
    // re-query runs, or the re-query would join it.
    expect(cancelOrder).toBeLessThan(queryOrder);

    const queryOptions = querySpy.mock.calls[0]?.[0];
    expect(queryOptions?.queryKey).toBe(queryKey);
    expect(queryOptions?.networkMode).toBe('always');
    expect(queryOptions?.retry).toBe(false);
    expect(queryOptions?.staleTime).toBe(0);
  });

  it('restores the original options after the forced attempt', async () => {
    const queryClient = new QueryClient();
    const queryKey = ['securityAgent', 'getConfig'] as const;
    queryClient.setQueryData(queryKey, { autoAnalysisEnabled: true });
    vi.spyOn(queryClient, 'cancelQueries').mockResolvedValue(undefined);
    vi.spyOn(queryClient, 'query').mockRejectedValue(new Error('still offline'));
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    const originalOptions = query?.options;

    await expect(retryPausedRead(queryClient, queryKey)).rejects.toThrow('still offline');

    expect(query?.options.networkMode).toBe(originalOptions?.networkMode);
    expect(query?.options).toStrictEqual(originalOptions);
  });

  it('is a no-op for a query key with no cached query', async () => {
    const queryClient = new QueryClient();
    const cancelSpy = vi.spyOn(queryClient, 'cancelQueries');
    const querySpy = vi.spyOn(queryClient, 'query');

    await expect(
      retryPausedRead(queryClient, ['securityAgent', 'missing'])
    ).resolves.toBeUndefined();

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe('usePausedReadRetry', () => {
  it('settles a failed attempt without an unhandled rejection and clears the busy state', async () => {
    const queryClient = new QueryClient();
    const queryKey = ['securityAgent', 'getConfig'] as const;
    queryClient.setQueryData(queryKey, { autoAnalysisEnabled: true });
    vi.spyOn(queryClient, 'cancelQueries').mockResolvedValue(undefined);
    let rejectAttempt: (reason: Error) => void = () => undefined;
    const attempt = Promise.withResolvers<never>();
    rejectAttempt = attempt.reject;
    vi.spyOn(queryClient, 'query').mockReturnValue(attempt.promise);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const observed: PausedReadRetry[] = [];
    function Probe() {
      observed.push(usePausedReadRetry(queryKey));
      return null;
    }
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe))
      );
    });
    const first = observed.at(-1);
    if (!first) {
      throw new Error('the hook did not render');
    }

    let settled: Promise<void> = Promise.resolve();
    try {
      act(() => {
        settled = first.retry();
      });
      expect(observed.at(-1)?.isRetrying).toBe(true);
      rejectAttempt(new Error('still offline'));
      // Await the attempt the hook exposed, not a guessed duration.
      await act(async () => {
        await settled;
      });

      expect(unhandled).toEqual([]);
      expect(observed.at(-1)?.isRetrying).toBe(false);
    } finally {
      // A failing assertion must still detach the process-wide listener, or
      // it leaks into every later test in this worker.
      process.off('unhandledRejection', onUnhandled);
    }

    act(() => {
      ref.current?.unmount();
    });
  });
});
