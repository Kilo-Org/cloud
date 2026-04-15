import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createCachedFetch } from './cached-fetch';

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
    const get = createCachedFetch(fetcher, 0, 'fallback'); // TTL=0 forces re-fetch every call

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
    const get = createCachedFetch(fetcher, 10_000, 'default');

    const result = await get();
    expect(result).toBe('default');
  });

  test('updates cached value after stale fallback when fetcher recovers', async () => {
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(20);
    const get = createCachedFetch(fetcher, 0, 0);

    expect(await get()).toBe(10);
    expect(await get()).toBe(10); // stale fallback
    expect(await get()).toBe(20); // recovered
  });
});
