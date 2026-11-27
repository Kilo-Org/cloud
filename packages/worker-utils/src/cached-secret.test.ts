import { afterEach, describe, expect, it } from 'vitest';
import { clearSecretCacheForTest, getCachedSecret } from './cached-secret.js';

afterEach(() => {
  clearSecretCacheForTest();
});

describe('getCachedSecret', () => {
  it('serves a resolved secret from the cache without another read', async () => {
    let reads = 0;
    const binding = {
      get: async () => {
        reads += 1;
        return 'secret-value';
      },
    };

    await expect(getCachedSecret(binding, 'KEY')).resolves.toBe('secret-value');
    await expect(getCachedSecret(binding, 'KEY')).resolves.toBe('secret-value');
    expect(reads).toBe(1);
  });

  it('does not hand a pending read to another caller', async () => {
    // workerd binds a promise's I/O to the request that created it, so a
    // request that joined another request's pending secret read would fail
    // when that other request was cancelled.
    const pending: Array<PromiseWithResolvers<string | null>> = [];
    const binding = {
      get: () => {
        const deferred = Promise.withResolvers<string | null>();
        pending.push(deferred);
        return deferred.promise;
      },
    };

    const cancelledRequest = getCachedSecret(binding, 'KEY');
    const otherRequest = getCachedSecret(binding, 'KEY');
    expect(pending).toHaveLength(2);

    pending[1].resolve('loaded by the second request');
    await expect(otherRequest).resolves.toBe('loaded by the second request');

    pending[0].reject(new Error('This promise was created by a request that has since ended'));
    await expect(cancelledRequest).rejects.toThrow('promise was created by a request');
  });

  it('does not cache a missing secret', async () => {
    let reads = 0;
    const binding = {
      get: async () => {
        reads += 1;
        return reads === 1 ? null : 'later-value';
      },
    };

    await expect(getCachedSecret(binding, 'KEY')).rejects.toThrow("Secret 'KEY' is not configured");
    await expect(getCachedSecret(binding, 'KEY')).resolves.toBe('later-value');
    expect(reads).toBe(2);
  });
});
