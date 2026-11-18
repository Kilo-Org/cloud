import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVercelJwksCache, OidcKeysUnavailable, vercelJwksUrl } from './vercel-jwks.js';
import { issuer, jwk, keysFetch, time } from './test-fixtures.js';

afterEach(() => vi.useRealTimers());

describe('bounded Vercel JWKS cache', () => {
  it.each([
    'http://oidc.vercel.com/team',
    'https://oidc.vercel.com:444/team',
    'https://user@oidc.vercel.com/team',
    'https://oidc.vercel.com/team?x=1',
    'https://oidc.vercel.com/team#fragment',
    'https://oidc.vercel.com/team/',
    'https://oidc.vercel.com.evil.test/team',
    'https://oidc.vercel.com/../team',
    'https://oidc.vercel.com:443/team',
  ])('rejects non-canonical or unsafe issuers: %s', value => {
    expect(vercelJwksUrl(value)).toBeNull();
  });
  it('coalesces refreshes and preserves fresh known keys while rotating', async () => {
    let now = time;
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => now });
    const known = await cache.key(issuer, 'current');
    now += 60_000;
    let complete!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const rotation = cache.key(issuer, 'rotated');
    const concurrent = cache.key(issuer, 'rotated');
    expect(await cache.key(issuer, 'current')).toBe(known);
    complete(Response.json({ keys: [jwk, { ...jwk, kid: 'rotated' }] }));
    expect(await rotation).toBe(await concurrent);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds unknown-kid refreshes across all kid values and preserves failure cooldown', async () => {
    let now = time;
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => now });
    await cache.key(issuer, 'current');
    for (let i = 0; i < 20; i++)
      await expect(cache.key(issuer, `missing-${i}`)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 60_000;
    fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(cache.key(issuer, 'unknown')).rejects.toBeInstanceOf(OidcKeysUnavailable);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 20; i++)
      await expect(cache.key(issuer, `other-${i}`)).rejects.toBeInstanceOf(OidcKeysUnavailable);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await cache.key(issuer, 'current')).toBeDefined();
  });
  it('never serves expired keys during an outage and recovers after cooldown', async () => {
    let now = time;
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => now });
    await cache.key(issuer, 'current');
    now += 5 * 60_000;
    fetch.mockRejectedValue(new Error('synthetic network failure'));
    await expect(cache.key(issuer, 'current')).rejects.toMatchObject({
      status: 503,
      code: 'oidc_keys_unavailable',
      retryAfter: 60,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockImplementation(async () => Response.json({ keys: [jwk] }));
    await expect(cache.key(issuer, 'current')).rejects.toBeInstanceOf(OidcKeysUnavailable);
    now += 60_000;
    expect(await cache.key(issuer, 'current')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each([301, 302, 400, 401, 403, 404, 429])(
    'does not follow or retry status %s',
    async status => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () => new Response(null, { status, headers: { Location: 'https://attacker.test' } })
      );
      await expect(createVercelJwksCache({ fetch }).key(issuer, 'current')).rejects.toBeInstanceOf(
        OidcKeysUnavailable
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    }
  );
  it('retries one network/5xx failure within one total deadline', async () => {
    const fetch = keysFetch();
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await createVercelJwksCache({ fetch }).key(issuer, 'current')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    const stalled = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const pending = createVercelJwksCache({ fetch: stalled }).key(issuer, 'current');
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it.each([
    () => new Response('x'.repeat(65537)),
    () => new Response('{}', { headers: { 'content-length': '65537' } }),
    () =>
      Response.json({ keys: Array.from({ length: 9 }, (_, i) => ({ ...jwk, kid: `key-${i}` })) }),
    () => Response.json({ keys: [jwk, jwk] }),
    () => Response.json({ keys: [{ ...jwk, alg: 'RS512' }] }),
    () => Response.json({ keys: [{ ...jwk, use: 'enc' }] }),
    () => Response.json({ keys: [{ ...jwk, key_ops: ['sign'] }] }),
    () => new Response('not-json'),
  ])('bounds and validates JWKS data', async response => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    await expect(createVercelJwksCache({ fetch }).key(issuer, 'current')).rejects.toBeInstanceOf(
      OidcKeysUnavailable
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not evict cooling entries to bypass the 32-issuer capacity', async () => {
    let now = time;
    const fetch = keysFetch();
    const cache = createVercelJwksCache({ fetch, now: () => now });
    for (let i = 0; i < 32; i++) await cache.key(`https://oidc.vercel.com/team-${i}`, 'current');
    await expect(cache.key('https://oidc.vercel.com/overflow', 'current')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).toHaveBeenCalledTimes(32);
    now += 60_000;
    expect(await cache.key('https://oidc.vercel.com/overflow', 'current')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(33);
  });
  it('does not evict in-flight entries even after their cooldown elapses', async () => {
    let now = time;
    const completions: Array<(response: Response) => void> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise(resolve => completions.push(resolve))
    );
    const cache = createVercelJwksCache({ fetch, now: () => now });
    const pending = Array.from({ length: 32 }, (_, i) =>
      cache.key(`https://oidc.vercel.com/team-${i}`, 'current')
    );
    now += 60_000;
    await expect(cache.key('https://oidc.vercel.com/overflow', 'current')).rejects.toMatchObject({
      status: 503,
    });
    completions.forEach(complete => complete(Response.json({ keys: [jwk] })));
    await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(32);
  });
});
