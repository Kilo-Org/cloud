import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createCachedFetch, FAILURE_BACKOFF_MS } from './cached-fetch';

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('createCachedFetch', () => {
  test('calls fetcher on first invocation', async () => {
    const fetcher = jest.fn<() => Promise<number>>().mockResolvedValue(42);
    const get = createCachedFetch(fetcher, 10_000, 0);

    const result = await get();

    expect(result).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('returns cached value within TTL without calling fetcher again', async () => {
    const fetcher = jest.fn<() => Promise<number>>().mockResolvedValue(42);
    const get = createCachedFetch(fetcher, 10_000, 0);

    await get();
    const result = await get();

    expect(result).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('re-fetches after TTL expires', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const get = createCachedFetch(fetcher, 500, 0);

    const first = await get();
    expect(first).toBe(1);

    // Still within TTL
    jest.spyOn(Date, 'now').mockReturnValue(1400);
    const cached = await get();
    expect(cached).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Past TTL
    jest.spyOn(Date, 'now').mockReturnValue(1600);
    const refreshed = await get();
    expect(refreshed).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('returns stale value when fetcher fails after a successful fetch', async () => {
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockRejectedValueOnce(new Error('Redis timeout'));
    const get = createCachedFetch(fetcher, 0, 'fallback', { failureBackoffMs: 0 });

    const first = await get();
    expect(first).toBe('good');

    const fallback = await get();
    expect(fallback).toBe('good');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('returns default value when fetcher fails and there is no cached value', async () => {
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('connection refused'));
    const get = createCachedFetch(fetcher, 10_000, 'default', { failureBackoffMs: 0 });

    const result = await get();
    expect(result).toBe('default');
  });

  test('updates cached value after stale fallback when fetcher recovers', async () => {
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(20);
    const get = createCachedFetch(fetcher, 0, 0, { failureBackoffMs: 0 });

    expect(await get()).toBe(10);
    expect(await get()).toBe(10); // stale fallback
    expect(await get()).toBe(20); // recovered
  });

  test('shares one in-flight refresh across concurrent callers after TTL expires', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
    let resolveRefresh: ((value: number) => void) | undefined;
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(
        () =>
          new Promise<number>(resolve => {
            resolveRefresh = resolve;
          })
      )
      .mockResolvedValue(3);
    const get = createCachedFetch(fetcher, 500, 0);

    expect(await get()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(600); // past TTL
    const first = get();
    const second = get();
    const third = get();
    expect(fetcher).toHaveBeenCalledTimes(2);

    resolveRefresh!(2);
    expect(await Promise.all([first, second, third])).toEqual([2, 2, 2]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    jest.spyOn(Date, 'now').mockReturnValue(1200); // TTL expired again
    expect(await get()).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('suppresses refresh attempts for the backoff window after a failure', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 1000, 'default');

    expect(await get()).toBe('good');

    jest.spyOn(Date, 'now').mockReturnValue(1000); // past TTL
    expect(await get()).toBe('good'); // failed refresh, stale value served
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Inside the backoff window the failing fetcher is not retried.
    jest.spyOn(Date, 'now').mockReturnValue(1000 + FAILURE_BACKOFF_MS - 1);
    expect(await get()).toBe('good');
    expect(fetcher).toHaveBeenCalledTimes(2);

    // At the deadline the refresh is allowed again.
    jest.spyOn(Date, 'now').mockReturnValue(1000 + FAILURE_BACKOFF_MS);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('serves the default value for the backoff window when nothing is cached', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 1000, 'default');

    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(FAILURE_BACKOFF_MS - 1);
    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(FAILURE_BACKOFF_MS);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('retries synchronous failures after each backoff window and recovers', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error('fixture failure');
      })
      .mockImplementationOnce(() => {
        throw new Error('fixture failure');
      })
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 10, 'default', { failureBackoffMs: 100 });

    expect(await get()).toBe('default');
    clock.mockReturnValue(100_099);
    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(100_100);
    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(100_199);
    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(2);

    clock.mockReturnValue(100_200);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
