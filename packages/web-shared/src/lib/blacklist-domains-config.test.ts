jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/utils.server'),
  errorExceptInTest: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { blacklisted_domains } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import { captureException } from '@sentry/nextjs';
import {
  BlacklistDomainsInputSchema,
  clearEmailBlacklistCache,
  getBlockedSignupTlds,
  isEmailBlacklisted,
  listBlacklistedDomains,
  normalizeSignupTlds,
  readBlacklistDomainsSettings,
} from '@kilocode/web-shared/lib/blacklist-domains-config';

const TTL_MS = 60_000;

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedCaptureException = jest.mocked(captureException);
const redisValues = new Map<string, string>();

const settings = (overrides: Record<string, unknown> = {}) => ({
  updated_at: '2026-01-01T00:00:00.000Z',
  updated_by: 'admin-id',
  updated_by_email: 'admin@example.com',
  ...overrides,
});

async function insertBlacklistedDomains(domains: string[]): Promise<void> {
  await db.insert(blacklisted_domains).values(domains.map(domain => ({ domain })));
}

// The settings cache reads Date.now on every call, so moving the clock past its TTL and
// failure backoff isolates each test from the values earlier tests cached.
let clockBase = Date.now();
let clock: jest.Spied<typeof Date.now>;

beforeEach(async () => {
  await cleanupDbForTest();
  clearEmailBlacklistCache();
  clockBase += 60 * 60_000;
  clock = jest.spyOn(Date, 'now').mockReturnValue(clockBase);
  redisValues.clear();
  mockedCaptureException.mockReset();
  mockedRedisGet.mockReset();
  mockedRedisGet.mockImplementation(async <T>(key: string) => {
    return (redisValues.get(key) ?? null) as T | null;
  });
  mockedRedisSet.mockReset();
  mockedRedisSet.mockImplementation(async (key: string, value: unknown, opts?: object) => {
    if (opts && 'nx' in opts && opts.nx && redisValues.has(key)) return null;
    redisValues.set(key, String(value));
    return 'OK';
  });
});

afterEach(() => {
  clock.mockRestore();
});

describe('isEmailBlacklisted', () => {
  test('matches the exact domain and its subdomains on label boundaries', async () => {
    await insertBlacklistedDomains(['spam.example']);

    await expect(isEmailBlacklisted('user@spam.example')).resolves.toBe(true);
    await expect(isEmailBlacklisted('user@MAIL.Spam.Example')).resolves.toBe(true);
    await expect(isEmailBlacklisted('user@notspam.example')).resolves.toBe(false);
    await expect(isEmailBlacklisted('user@spam.example.org')).resolves.toBe(false);
  });

  test('matches an address without @ only on a dotted suffix', async () => {
    await insertBlacklistedDomains(['spam.example']);

    await expect(isEmailBlacklisted('deep.spam.example')).resolves.toBe(true);
    await expect(isEmailBlacklisted('spam.example')).resolves.toBe(false);
  });

  test('returns false for an empty table', async () => {
    await expect(isEmailBlacklisted('user@example.com')).resolves.toBe(false);
  });

  test('caches answers until the cache is cleared', async () => {
    await insertBlacklistedDomains(['spam.example']);
    await expect(isEmailBlacklisted('user@spam.example')).resolves.toBe(true);
    await expect(isEmailBlacklisted('other@legit.example')).resolves.toBe(false);

    await db.delete(blacklisted_domains).where(eq(blacklisted_domains.domain, 'spam.example'));
    await insertBlacklistedDomains(['legit.example']);

    await expect(isEmailBlacklisted('another@spam.example')).resolves.toBe(true);
    await expect(isEmailBlacklisted('another@legit.example')).resolves.toBe(false);

    clearEmailBlacklistCache();

    await expect(isEmailBlacklisted('another@spam.example')).resolves.toBe(false);
    await expect(isEmailBlacklisted('another@legit.example')).resolves.toBe(true);
  });

  test('reads through the given database', async () => {
    await insertBlacklistedDomains(['spam.example']);
    const fromDb = { select: jest.fn(db.select.bind(db)) } as unknown as Pick<typeof db, 'select'>;

    await expect(isEmailBlacklisted('user@spam.example', fromDb)).resolves.toBe(true);
    expect(fromDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('listBlacklistedDomains', () => {
  test('returns every stored domain in order', async () => {
    await insertBlacklistedDomains(['spam.org', 'mailinator.com', 'bad.net']);

    await expect(listBlacklistedDomains()).resolves.toEqual([
      'bad.net',
      'mailinator.com',
      'spam.org',
    ]);
  });

  test('returns an empty list for an empty table', async () => {
    await expect(listBlacklistedDomains()).resolves.toEqual([]);
  });
});

describe('readBlacklistDomainsSettings', () => {
  test('reads the settings key without touching the legacy value', async () => {
    const stored = settings({ blocked_signup_tlds: ['asia'] });
    redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(stored));
    redisValues.set(
      LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({ ...settings({ blocked_signup_tlds: ['shop'] }), domains: ['old.example'] })
    );

    await expect(readBlacklistDomainsSettings()).resolves.toEqual(stored);
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
    ]);
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('returns null when neither key holds settings', async () => {
    await expect(readBlacklistDomainsSettings()).resolves.toBeNull();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('copies the legacy settings without their domains and leaves the legacy value unchanged', async () => {
    const legacySettings = settings({ blocked_signup_tlds: ['asia'] });
    const legacyRaw = JSON.stringify({
      ...legacySettings,
      domains: ['old.example', 'spam.example'],
    });
    redisValues.set(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY, legacyRaw);

    await expect(readBlacklistDomainsSettings()).resolves.toEqual(legacySettings);

    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      expect.any(String),
      { nx: true }
    );
    const migrated = JSON.parse(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null');
    expect(migrated).toEqual(legacySettings);
    expect(migrated).not.toHaveProperty('domains');
    expect(redisValues.get(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY)).toBe(legacyRaw);
  });

  test('keeps settings an admin saved while the legacy value was being migrated', async () => {
    const saved = settings({ blocked_signup_tlds: ['top'], updated_by: 'newer-admin' });
    redisValues.set(
      LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({ ...settings({ blocked_signup_tlds: ['asia'] }), domains: [] })
    );
    let settingsReads = 0;
    mockedRedisGet.mockImplementation(async <T>(key: string) => {
      if (key === BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY && settingsReads++ === 0) {
        redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(saved));
        return null;
      }
      return (redisValues.get(key) ?? null) as T | null;
    });

    await expect(readBlacklistDomainsSettings()).resolves.toEqual(saved);
    expect(JSON.parse(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')).toEqual(
      saved
    );
  });

  test('returns settings a concurrent save wrote after deleting the legacy value', async () => {
    const saved = settings({ blocked_signup_tlds: ['asia'], updated_by: 'newer-admin' });
    let settingsReads = 0;
    mockedRedisGet.mockImplementation(async <T>(key: string) => {
      if (key === BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY && settingsReads++ === 0) {
        redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(saved));
        return null;
      }
      return (redisValues.get(key) ?? null) as T | null;
    });

    await expect(readBlacklistDomainsSettings()).resolves.toEqual(saved);
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
    ]);
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('throws on an unreadable settings value', async () => {
    redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, '{not json');

    await expect(readBlacklistDomainsSettings()).rejects.toBeInstanceOf(SyntaxError);
  });

  test('throws on an unreadable legacy value without writing the settings key', async () => {
    redisValues.set(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY, '{not json');

    await expect(readBlacklistDomainsSettings()).rejects.toBeInstanceOf(SyntaxError);
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });
});

describe('getBlockedSignupTlds', () => {
  test('returns the stored list, normalized', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(settings({ blocked_signup_tlds: ['.ASIA', 'asia', ' top '] }))
    );

    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia', 'top']);
  });

  test('honors an explicit empty list', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(settings({ blocked_signup_tlds: [] }))
    );

    await expect(getBlockedSignupTlds()).resolves.toEqual([]);
  });

  test('falls back to the deployment default when no list is stored', async () => {
    redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(settings()));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
  });

  test('serves the cached list within the TTL and refreshes after it', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(settings({ blocked_signup_tlds: ['asia'] }))
    );
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);

    redisValues.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(settings({ blocked_signup_tlds: ['top'] }))
    );
    clock.mockReturnValue(clockBase + TTL_MS - 1);
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(mockedRedisGet).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(clockBase + TTL_MS + 1);
    await expect(getBlockedSignupTlds()).resolves.toEqual(['top']);
  });

  test('keeps the last list read when a later read fails, and reports it', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(settings({ blocked_signup_tlds: ['asia'] }))
    );
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);

    const failure = new Error('redis read timed out');
    mockedRedisGet.mockRejectedValueOnce(failure);
    clock.mockReturnValue(clockBase + TTL_MS + 1);

    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    expect(mockedCaptureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ tags: { source: 'blacklist_domains_config' } })
    );
  });

  // A fresh module instance has no last-known-good settings and re-reads BLOCKED_SIGNUP_TLDS.
  async function withFreshConfig(
    run: (modules: {
      getBlockedSignupTlds: typeof getBlockedSignupTlds;
      redisGet: typeof mockedRedisGet;
      captureException: typeof mockedCaptureException;
    }) => Promise<void>
  ): Promise<void> {
    await jest.isolateModulesAsync(async () => {
      const [config, redis, sentry] = await Promise.all([
        import('@kilocode/web-shared/lib/blacklist-domains-config'),
        import('@kilocode/web-shared/lib/redis'),
        import('@sentry/nextjs'),
      ]);
      await run({
        getBlockedSignupTlds: config.getBlockedSignupTlds,
        redisGet: jest.mocked(redis.redisClient.get),
        captureException: jest.mocked(sentry.captureException),
      });
    });
  }

  test('reports a failing first read and serves the deployment default', async () => {
    await withFreshConfig(async ({ getBlockedSignupTlds, redisGet, captureException }) => {
      redisGet.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });

  test('uses BLOCKED_SIGNUP_TLDS as the fallback when it is set', async () => {
    const previous = process.env.BLOCKED_SIGNUP_TLDS;
    process.env.BLOCKED_SIGNUP_TLDS = '.ASIA|xyz';
    try {
      await withFreshConfig(async ({ getBlockedSignupTlds, redisGet }) => {
        redisGet.mockResolvedValue(null);

        await expect(getBlockedSignupTlds()).resolves.toEqual(['asia', 'xyz']);
      });
    } finally {
      if (previous === undefined) delete process.env.BLOCKED_SIGNUP_TLDS;
      else process.env.BLOCKED_SIGNUP_TLDS = previous;
    }
  });
});

describe('normalizeSignupTlds', () => {
  test('strips leading dots, lowercases, trims, and removes blanks and duplicates', () => {
    expect(normalizeSignupTlds([' .ASIA ', 'asia', '..Top', '', '   ', 'shop'])).toEqual([
      'asia',
      'top',
      'shop',
    ]);
  });
});

describe('BlacklistDomainsInputSchema', () => {
  test('accepts a list longer than the former Redis cap', () => {
    const domains = Array.from({ length: 200_001 }, (_, index) => `bulk-${index}.example`);

    expect(BlacklistDomainsInputSchema.safeParse({ domains }).success).toBe(true);
  });

  test('rejects an empty domain entry', () => {
    expect(BlacklistDomainsInputSchema.safeParse({ domains: [''] }).success).toBe(false);
  });

  test('trims entries and accepts optional signup TLDs', () => {
    expect(
      BlacklistDomainsInputSchema.parse({ domains: [' spam.example '], blocked_tlds: [' asia '] })
    ).toEqual({ domains: ['spam.example'], blocked_tlds: ['asia'] });
  });
});
