import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { createCachedFetch } from './cached-fetch';

beforeEach(() => {
  jest.restoreAllMocks();
});

async function flushMicrotasks() {
  // Two awaits drain the .then/.catch/.finally chain in refresh().
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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

  test('past TTL returns stale value immediately and refreshes in background', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const get = createCachedFetch(fetcher, 500, 0);

    const first = await get();
    expect(first).toBe(1);

    // Still within TTL.
    jest.spyOn(Date, 'now').mockReturnValue(1400);
    const cached = await get();
    expect(cached).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Past TTL: stale-while-revalidate returns the stale value
    // and kicks off a background refresh.
    jest.spyOn(Date, 'now').mockReturnValue(1600);
    const stale = await get();
    expect(stale).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await flushMicrotasks();

    const refreshed = await get();
    expect(refreshed).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('keeps serving stale value when background refresh fails', async () => {
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockRejectedValueOnce(new Error('Redis timeout'))
      // Further stale-triggered background refreshes after the failure keep
      // failing; we still expect the cached 'good' to be served.
      .mockRejectedValue(new Error('Redis timeout'));
    const get = createCachedFetch(fetcher, 0, 'fallback');

    expect(await get()).toBe('good');

    const stale = await get();
    expect(stale).toBe('good');
    expect(fetcher).toHaveBeenCalledTimes(2);

    await flushMicrotasks();

    expect(await get()).toBe('good');
  });

  test('returns default value when fetcher fails and there is no cached value', async () => {
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('connection refused'));
    const get = createCachedFetch(fetcher, 10_000, 'default');

    const result = await get();
    expect(result).toBe('default');
  });

  test('background refresh updates cached value after a transient failure', async () => {
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(20);
    const get = createCachedFetch(fetcher, 0, 0);

    expect(await get()).toBe(10);
    expect(await get()).toBe(10); // stale; background refresh fails
    await flushMicrotasks();

    expect(await get()).toBe(10); // still stale; triggers another refresh
    await flushMicrotasks();

    expect(await get()).toBe(20); // next read sees the recovered value
  });

  test('concurrent callers share a single in-flight fetch', async () => {
    let resolve: (value: number) => void = () => {};
    const fetcher = jest.fn<() => Promise<number>>().mockImplementation(
      () =>
        new Promise<number>(r => {
          resolve = r;
        })
    );
    const get = createCachedFetch(fetcher, 10_000, 0);

    const a = get();
    const b = get();
    const c = get();

    expect(fetcher).toHaveBeenCalledTimes(1);

    resolve(7);

    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(await c).toBe(7);
  });
});
