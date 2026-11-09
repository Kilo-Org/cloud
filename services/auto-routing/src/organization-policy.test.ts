import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest } from '@kilocode/worker-utils';
import { domainBlacklistCache } from './organization-policy';

const env = {
  UPSTASH_REDIS_REST_URL: { get: async () => 'https://redis.example.test' },
  UPSTASH_REDIS_REST_TOKEN: { get: async () => 'redis-test-token' },
};

describe('domainBlacklistCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearSecretCacheForTest();
  });

  it('reads and writes selective keys through Redis commands with a 200ms timeout', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ result: '0' }))
      .mockResolvedValueOnce(Response.json({ result: 'OK' }));
    vi.stubGlobal('fetch', fetch);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const cache = domainBlacklistCache(env, { waitUntil: vi.fn() });
    const key = 'domain-blacklist:revision-1:host:example.com';

    expect(await cache.get(key)).toBe('0');
    expect(await cache.set(key, '1', 60)).toBe('OK');
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init?.body as string))).toEqual([
      ['GET', key],
      ['SET', key, '1', 'EX', 60],
    ]);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe('https://redis.example.test');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer redis-test-token');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(timeout.mock.calls).toEqual([[200], [200]]);
  });

  it('returns null for a cache miss', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ result: null })));
    expect(await domainBlacklistCache(env, { waitUntil: vi.fn() }).get('missing')).toBeNull();
  });

  it.each([
    () => Response.json({ result: 0 }),
    () => Response.json({ error: 'invalid command' }),
    () => new Response('unavailable', { status: 503 }),
  ])(
    'rejects invalid or unavailable Redis reads for the shared helper to fall back',
    async response => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
      await expect(domainBlacklistCache(env, { waitUntil: vi.fn() }).get('key')).rejects.toThrow();
    }
  );

  it('rejects failed cache writes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'write denied' })));
    await expect(
      domainBlacklistCache(env, { waitUntil: vi.fn() }).set('key', '0', 60)
    ).rejects.toThrow();
  });

  it('schedules cache writes through the execution context without losing its receiver', async () => {
    const write = vi.fn(async () => {});
    const context = { waitUntil: vi.fn() };
    domainBlacklistCache(env, context).defer(write);
    expect(write).toHaveBeenCalledOnce();
    expect(context.waitUntil).toHaveBeenCalledWith(write.mock.results[0]?.value);
    expect(context.waitUntil.mock.contexts).toEqual([context]);
    await write.mock.results[0]?.value;
  });

  it('reports cache failures without logging credentials or the domain key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    domainBlacklistCache(env, { waitUntil: vi.fn() }).onError(new Error('cache unavailable'));
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: 'auto_routing_domain_blacklist_cache_failed',
    });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('redis-test-token');
  });
});
