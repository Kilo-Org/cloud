import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttlCached } from './ttl-cache.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ttlCached', () => {
  it('does not hand a pending load to another caller', async () => {
    // workerd binds a promise's I/O to the request that created it. When the
    // request that started a shared load is cancelled, its promise rejects and
    // every request waiting on it would fail too, so each caller must await
    // only the load it started.
    const pending: Array<PromiseWithResolvers<string>> = [];
    const cache = ttlCached<string, string>(60_000, () => {
      const deferred = Promise.withResolvers<string>();
      pending.push(deferred);
      return deferred.promise;
    });

    const cancelledRequest = cache.get('env');
    const otherRequest = cache.get('env');
    expect(pending).toHaveLength(2);

    pending[1].resolve('loaded by the second request');
    await expect(otherRequest).resolves.toBe('loaded by the second request');

    pending[0].reject(new Error('This promise was created by a request that has since ended'));
    await expect(cancelledRequest).rejects.toThrow('promise was created by a request');
  });

  it('serves a resolved value from the cache within the TTL without another load', async () => {
    let loads = 0;
    const cache = ttlCached<string, number>(60_000, async () => {
      loads += 1;
      return loads;
    });

    await expect(cache.get('env')).resolves.toBe(1);
    await expect(cache.get('env')).resolves.toBe(1);
    expect(loads).toBe(1);
  });

  it('does not cache a rejected load', async () => {
    let loads = 0;
    const cache = ttlCached<string, string>(60_000, async () => {
      loads += 1;
      if (loads === 1) throw new Error('KV unavailable');
      return 'loaded';
    });

    await expect(cache.get('env')).rejects.toThrow('KV unavailable');
    await expect(cache.get('env')).resolves.toBe('loaded');
    expect(loads).toBe(2);
  });

  it('loads again once the TTL has passed', async () => {
    vi.useFakeTimers();
    let loads = 0;
    const cache = ttlCached<string, number>(1_000, async () => {
      loads += 1;
      return loads;
    });

    await expect(cache.get('env')).resolves.toBe(1);
    vi.advanceTimersByTime(999);
    await expect(cache.get('env')).resolves.toBe(1);
    vi.advanceTimersByTime(1);
    await expect(cache.get('env')).resolves.toBe(2);
    expect(loads).toBe(2);
  });

  it('loads again after clear()', async () => {
    let loads = 0;
    const cache = ttlCached<string, number>(60_000, async () => {
      loads += 1;
      return loads;
    });

    await expect(cache.get('env')).resolves.toBe(1);
    cache.clear();
    await expect(cache.get('env')).resolves.toBe(2);
  });
});
