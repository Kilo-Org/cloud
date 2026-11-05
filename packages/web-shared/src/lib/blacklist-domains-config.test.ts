import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import { MAX_BLACKLIST_DOMAINS } from '@kilocode/worker-utils/account-access';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({ redisClient: { get: jest.fn() } }));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/utils.server'),
  errorExceptInTest: jest.fn(),
}));

type TestMocks = {
  redisGet: jest.Mock<(key: string) => Promise<string | null>>;
  captureException: jest.Mock<(error: unknown, ...rest: unknown[]) => void>;
  reportDropped: jest.Mock<(message: string, extra?: unknown) => void>;
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
    getBlockedSignupTlds: () => Promise<string[]>;
  }
> {
  jest.resetModules();
  const [config, redis, sentry, utils] = await Promise.all([
    import('@kilocode/web-shared/lib/blacklist-domains-config'),
    import('@kilocode/web-shared/lib/redis'),
    import('@sentry/nextjs'),
    import('@kilocode/web-shared/lib/utils.server'),
  ]);
  return {
    getBlacklistedDomains: config.getBlacklistedDomains,
    getBlockedSignupTlds: config.getBlockedSignupTlds,
    redisGet: redis.redisClient.get as unknown as TestMocks['redisGet'],
    captureException: sentry.captureException as unknown as TestMocks['captureException'],
    reportDropped: utils.errorExceptInTest as unknown as TestMocks['reportDropped'],
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

  test('rechecks only the updated_at key while the list is unchanged', async () => {
    const { getBlacklistedDomains, redisGet } = await loadGetBlacklistedDomains();
    const updatedAt = '2026-10-22T13:30:00.000Z';
    redisGet.mockImplementation(async key =>
      key === BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY
        ? updatedAt
        : JSON.stringify({
            domains: ['spam.example'],
            updated_at: updatedAt,
            updated_by: null,
            updated_by_email: null,
          })
    );

    const first = await getBlacklistedDomains();
    clock.mockReturnValue(TTL_MS + 1);
    const second = await getBlacklistedDomains();

    expect(second).toBe(first);
    expect(redisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLIST_DOMAINS_REDIS_KEY,
      BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
    ]);
  });

  test('serves the domain and signup TLD lists from one config read', async () => {
    const { getBlacklistedDomains, getBlockedSignupTlds, redisGet } =
      await loadGetBlacklistedDomains();
    redisGet.mockResolvedValue(
      JSON.stringify({
        domains: ['spam.example'],
        blocked_signup_tlds: ['.ASIA'],
        updated_at: null,
        updated_by: null,
        updated_by_email: null,
      })
    );

    await expect(getBlacklistedDomains()).resolves.toEqual(['spam.example']);
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(redisGet).toHaveBeenCalledTimes(1);
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

describe('over-cap stored config reporting', () => {
  test('reports a loaded over-cap config once per config, across cache refreshes', async () => {
    const { getBlacklistedDomains, redisGet, reportDropped } = await loadGetBlacklistedDomains();
    const domains = Array.from(
      { length: MAX_BLACKLIST_DOMAINS + 5 },
      (_, index) => `bulk-${index}.example`
    );
    redisGet.mockResolvedValue(
      JSON.stringify({ domains, updated_at: 't1', updated_by: null, updated_by_email: null })
    );

    await getBlacklistedDomains();
    clock.mockReturnValue(TTL_MS + 1);
    await getBlacklistedDomains();
    clock.mockReturnValue(2 * TTL_MS + 2);
    await getBlacklistedDomains();

    expect(reportDropped).toHaveBeenCalledTimes(1);
    expect(reportDropped).toHaveBeenCalledWith(expect.any(String), { droppedDomains: 5 });
  });
});

describe('BlacklistDomainsInputSchema', () => {
  async function loadInputSchema() {
    jest.resetModules();
    const [config, accountAccess] = await Promise.all([
      import('@kilocode/web-shared/lib/blacklist-domains-config'),
      import('@kilocode/worker-utils/account-access'),
    ]);
    return {
      schema: config.BlacklistDomainsInputSchema,
      max: accountAccess.MAX_BLACKLIST_DOMAINS,
    };
  }

  test('accepts an admin save at the cap', async () => {
    const { schema, max } = await loadInputSchema();
    const domains = Array.from({ length: max }, (_, index) => `bulk-${index}.example`);

    expect(schema.safeParse({ domains }).success).toBe(true);
  });

  test('rejects an admin save one entry over the cap', async () => {
    const { schema, max } = await loadInputSchema();
    const domains = Array.from({ length: max + 1 }, (_, index) => `bulk-${index}.example`);

    expect(schema.safeParse({ domains }).success).toBe(false);
  });
});
