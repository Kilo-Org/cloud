import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: { get: jest.fn() } }));

type TestMocks = {
  redisGet: jest.Mock<(key: string) => Promise<string | null>>;
  captureException: jest.Mock<(error: unknown, ...rest: unknown[]) => void>;
};

const TTL_MS = 60_000;
const storedConfig = (domains: string[]) =>
  JSON.stringify({ domains, updated_at: null, updated_by: null, updated_by_email: null });

/**
 * The module keeps its read cache for its lifetime, so every case needs a fresh instance:
 * env vars and the mocked Redis/Sentry functions are resolved again after resetModules.
 */
async function loadGetBlacklistedDomains(): Promise<
  TestMocks & {
    getBlacklistedDomains: () => Promise<string[]>;
  }
> {
  jest.resetModules();
  const [config, redis, sentry] = await Promise.all([
    import('@kilocode/web-shared/lib/blacklist-domains-config'),
    import('@kilocode/web-shared/lib/redis'),
    import('@sentry/nextjs'),
  ]);
  return {
    getBlacklistedDomains: config.getBlacklistedDomains,
    redisGet: redis.redisClient.get as unknown as TestMocks['redisGet'],
    captureException: sentry.captureException as unknown as TestMocks['captureException'],
  };
}

let clock: jest.Spied<typeof Date.now>;

beforeEach(() => {
  delete process.env.BLACKLIST_DOMAINS;
  clock = jest.spyOn(Date, 'now').mockReturnValue(0);
});

afterEach(() => {
  clock.mockRestore();
  delete process.env.BLACKLIST_DOMAINS;
});

describe('getBlacklistedDomains', () => {
  test('returns the stored domains', async () => {
    process.env.BLACKLIST_DOMAINS = 'env.example';
    const { getBlacklistedDomains, redisGet, captureException } = await loadGetBlacklistedDomains();
    redisGet.mockResolvedValue(storedConfig(['spam.example']));

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);
    expect(captureException).not.toHaveBeenCalled();
  });

  test('keeps the last domains read when a later read fails, and reports it once', async () => {
    const { getBlacklistedDomains, redisGet, captureException } = await loadGetBlacklistedDomains();
    redisGet.mockResolvedValueOnce(storedConfig(['spam.example']));

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);

    const failure = new Error('redis read timed out');
    redisGet.mockRejectedValueOnce(failure);
    clock.mockReturnValue(TTL_MS + 1);

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ tags: { source: 'blacklist_domains_config' } })
    );

    // The failed refresh is reported once; callers inside the backoff window reuse it.
    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);
    expect(redisGet).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  test('reports a failing first read and serves the BLACKLIST_DOMAINS list', async () => {
    process.env.BLACKLIST_DOMAINS = 'env.example|other.example';
    const { getBlacklistedDomains, redisGet, captureException } = await loadGetBlacklistedDomains();
    const failure = new Error('connect ECONNREFUSED');
    redisGet.mockRejectedValue(failure);

    await expect(getBlacklistedDomains()).resolves.toEqual(['env.example', 'other.example']);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ tags: { source: 'blacklist_domains_config' } })
    );
  });

  test('reports an unreadable stored payload and keeps the last domains read', async () => {
    const { getBlacklistedDomains, redisGet, captureException } = await loadGetBlacklistedDomains();
    redisGet.mockResolvedValueOnce(storedConfig(['spam.example']));

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);

    redisGet.mockResolvedValueOnce('{not json');
    clock.mockReturnValue(TTL_MS + 1);

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(SyntaxError);
  });
});
