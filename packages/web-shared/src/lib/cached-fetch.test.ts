import { describe, test, expect, jest } from '@jest/globals';

import { createCachedFetch, FAILURE_BACKOFF_MS, type RefreshFailureInfo } from './cached-fetch';

/** A clock the test advances by hand, so nothing depends on elapsed time. */
function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    advanceBy: (ms: number) => {
      current += ms;
    },
  };
}

describe('createCachedFetch', () => {
  test('calls the fetcher on the first invocation', async () => {
    const fetcher = jest.fn<() => Promise<number>>().mockResolvedValue(42);
    const clock = createClock(1_000);
    const get = createCachedFetch(fetcher, 10_000, 0, { name: 'test-cache', now: clock.now });

    await expect(get()).resolves.toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('serves the cached value until the TTL boundary and refreshes exactly once there', async () => {
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const clock = createClock(1_000);
    const get = createCachedFetch(fetcher, 500, 0, { name: 'test-cache', now: clock.now });

    expect(await get()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.set(1_499);
    expect(await get()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.set(1_500);
    expect(await get()).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);

    clock.set(1_999);
    expect(await get()).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('measures the TTL from when the value arrived, not from when the call started', async () => {
    const clock = createClock(0);
    const fetcher = jest.fn(async () => {
      clock.advanceBy(400);
      return 1;
    });
    const get = createCachedFetch(fetcher, 1_000, 0, { name: 'test-cache', now: clock.now });

    expect(await get()).toBe(1);

    clock.advanceBy(999);
    expect(await get()).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('shares one refresh across concurrent callers and reports the failure once', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const pending = Promise.withResolvers<string>();
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockImplementationOnce(() => pending.promise);
    const get = createCachedFetch(fetcher, 1_000, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('good');

    clock.set(1_000);
    const first = get();
    const second = get();
    const third = get();
    expect(fetcher).toHaveBeenCalledTimes(2);

    const failure = new Error('Redis timeout');
    pending.reject(failure);
    expect(await Promise.all([first, second, third])).toEqual(['good', 'good', 'good']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([
      {
        name: 'test-cache',
        error: failure,
        served: 'last-known-good',
        failureBackoffMs: FAILURE_BACKOFF_MS,
      },
    ]);
  });

  test('serves the default value and reports it when the first refresh fails', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const failure = new Error('connection refused');
    const fetcher = jest.fn<() => Promise<string>>().mockRejectedValueOnce(failure);
    const get = createCachedFetch(fetcher, 10_000, 'default', {
      name: 'openRouterProviders',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('default');
    expect(reported).toEqual([
      {
        name: 'openRouterProviders',
        error: failure,
        served: 'default',
        failureBackoffMs: FAILURE_BACKOFF_MS,
      },
    ]);
  });

  test('reports the last-known-good value it serves after a failed refresh', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const failure = new TypeError('fetch failed');
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockRejectedValueOnce(failure);
    const get = createCachedFetch(fetcher, 1_000, 'default', {
      name: 'runtimeGatewayRoutingConfig',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('good');

    clock.set(1_000);
    expect(await get()).toBe('good');
    expect(reported).toEqual([
      {
        name: 'runtimeGatewayRoutingConfig',
        error: failure,
        served: 'last-known-good',
        failureBackoffMs: FAILURE_BACKOFF_MS,
      },
    ]);
  });

  test('suppresses retries and reports inside the backoff window, then refreshes at its deadline', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('good')
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 1_000, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('good');

    clock.set(1_000);
    expect(await get()).toBe('good');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reported).toHaveLength(1);

    clock.set(1_000 + FAILURE_BACKOFF_MS - 1);
    expect(await get()).toBe('good');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(reported).toHaveLength(1);

    clock.set(1_000 + FAILURE_BACKOFF_MS);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(reported).toHaveLength(1);
  });

  test('serves the default value for the default backoff window when nothing is cached', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 1_000, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reported[0]?.failureBackoffMs).toBe(FAILURE_BACKOFF_MS);

    clock.set(FAILURE_BACKOFF_MS - 1);
    expect(await get()).toBe('default');
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.set(FAILURE_BACKOFF_MS);
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('retries on the next call when the backoff is zero', async () => {
    const clock = createClock(0);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue('recovered');
    const get = createCachedFetch(fetcher, 10_000, 'default', {
      name: 'test-cache',
      failureBackoffMs: 0,
      now: clock.now,
    });

    expect(await get()).toBe('default');
    expect(await get()).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('reports a non-Error rejection unchanged', async () => {
    const clock = createClock(0);
    const reported: RefreshFailureInfo[] = [];
    const fetcher = jest.fn<() => Promise<string>>().mockRejectedValueOnce('boom');
    const get = createCachedFetch(fetcher, 10, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: info => {
        reported.push(info);
      },
    });

    expect(await get()).toBe('default');
    expect(reported).toEqual([
      {
        name: 'test-cache',
        error: 'boom',
        served: 'default',
        failureBackoffMs: FAILURE_BACKOFF_MS,
      },
    ]);
  });

  test('refreshes a stale value whatever origin the clock has', async () => {
    const fetcher = jest
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const clock = createClock(-10_000);
    const get = createCachedFetch(fetcher, 1_000, 0, { name: 'test-cache', now: clock.now });

    expect(await get()).toBe(1);

    clock.set(-8_000);
    expect(await get()).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('serves the fallback when the failure reporter throws', async () => {
    const clock = createClock(0);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'));
    const get = createCachedFetch(fetcher, 10, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: () => {
        throw new Error('reporter down');
      },
    });

    await expect(get()).resolves.toBe('default');
  });

  test('serves the fallback when an async failure reporter rejects', async () => {
    const clock = createClock(0);
    const fetcher = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'));
    const get = createCachedFetch(fetcher, 10, 'default', {
      name: 'test-cache',
      now: clock.now,
      onRefreshFailure: async () => {
        throw new Error('reporter down');
      },
    });

    await expect(get()).resolves.toBe('default');
    await new Promise(resolve => setImmediate(resolve));
  });
});
