jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));

// The Sentry client is the reporting boundary: the mock counts reports without sending them.
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

// `errorExceptInTest` is a no-op under IS_IN_AUTOMATED_TEST, so spy on it to count log lines.
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/utils.server'),
  errorExceptInTest: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import { blacklisted_domains, blacklisted_domains_settings } from '@kilocode/db/schema';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BlacklistDomainsInputSchema,
  clearEmailBlacklistCache,
  getBlockedSignupTlds,
  isEmailBlacklisted,
  listBlacklistedDomains,
  normalizeSignupTlds,
  readBlacklistDomainsSettings,
  resetSignupTldStateForTest,
} from '@kilocode/web-shared/lib/blacklist-domains-config';

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedCaptureException = jest.mocked(captureException);
const mockedErrorLog = jest.mocked(errorExceptInTest);
const settings = (blocked_signup_tlds: string[]) => ({
  blocked_signup_tlds,
  updated_at: '2026-04-29 01:16:12.945+00',
  updated_by: 'admin-id',
  updated_by_email: 'admin@example.com',
});

async function insertBlacklistedDomains(domains: string[]): Promise<void> {
  await db.insert(blacklisted_domains).values(domains.map(domain => ({ domain })));
}

beforeEach(async () => {
  await cleanupDbForTest();
  clearEmailBlacklistCache();
  resetSignupTldStateForTest();
  mockedRedisGet.mockReset();
  mockedRedisSet.mockReset();
  mockedCaptureException.mockReset();
  mockedErrorLog.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
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
  test('reads Postgres instead of different Redis settings and normalizes the timestamp', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['shop'])));
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));

    await expect(readBlacklistDomainsSettings()).resolves.toEqual({
      ...settings(['asia']),
      updated_at: '2026-04-29T01:16:12.945Z',
    });
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('returns null for an absent row even if Redis has settings', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['asia'])));

    await expect(readBlacklistDomainsSettings()).resolves.toBeNull();
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('preserves an explicitly empty list', async () => {
    await db.insert(blacklisted_domains_settings).values(settings([]));

    await expect(readBlacklistDomainsSettings()).resolves.toMatchObject({
      blocked_signup_tlds: [],
    });
  });

  test('reads uncommitted settings through the given transaction', async () => {
    await db.transaction(async tx => {
      await tx.insert(blacklisted_domains_settings).values(settings(['asia']));
      await expect(readBlacklistDomainsSettings(tx)).resolves.toMatchObject({
        blocked_signup_tlds: ['asia'],
      });
    });
  });

  test('surfaces a database failure instead of reading Redis', async () => {
    const failure = new Error('database unavailable');
    const fromDb = {
      select: jest.fn(() => {
        throw failure;
      }),
    } as unknown as Pick<typeof db, 'select'>;
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['asia'])));

    await expect(readBlacklistDomainsSettings(fromDb)).rejects.toBe(failure);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });
});

describe('getBlockedSignupTlds', () => {
  test('returns the stored list, normalized, even when Redis differs', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['shop'])));
    await db.insert(blacklisted_domains_settings).values(settings(['.ASIA', 'asia', ' top ']));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia', 'top']);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('honors an explicit empty list', async () => {
    await db.insert(blacklisted_domains_settings).values(settings([]));

    await expect(getBlockedSignupTlds()).resolves.toEqual([]);
  });

  test('strips a trailing dot from a stored TLD', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['.ASIA.']));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
  });

  test('falls back to the deployment default only when no row exists', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['asia'])));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('reads updated and deleted settings on successive calls without a cache', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);

    await db
      .update(blacklisted_domains_settings)
      .set({ blocked_signup_tlds: ['top'] })
      .where(eq(blacklisted_domains_settings.id, 1));
    await expect(getBlockedSignupTlds()).resolves.toEqual(['top']);

    await db.delete(blacklisted_domains_settings).where(eq(blacklisted_domains_settings.id, 1));
    await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
  });

  test('an outage after a successful read keeps the admin list and reports once per window', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);

    const failure = new Error('database unavailable');
    const select = jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['shop'])));
    try {
      // Pre-#11609 createCachedFetch caught the reported error and served the last-known-good
      // settings, so an outage left the admin's list in force instead of relaxing the gate.
      await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledWith(failure, {
        tags: { source: 'blacklist_domains_config' },
      });
      expect(mockedErrorLog).toHaveBeenCalledTimes(1);
      expect(mockedErrorLog).toHaveBeenCalledWith(
        '[blacklist-domains] Failed to read the signup TLD settings:',
        failure
      );

      // Inside the window a repeated failure serves the same remembered settings, and neither
      // the Sentry event nor the console line repeats: one signup attempt is not one log line.
      await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      expect(mockedErrorLog).toHaveBeenCalledTimes(1);
      expect(mockedRedisGet).not.toHaveBeenCalled();
      expect(mockedRedisSet).not.toHaveBeenCalled();
    } finally {
      select.mockRestore();
    }
  });

  test('an outage before any successful read uses the deployment list', async () => {
    const failure = new Error('database unavailable');
    const select = jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });
    try {
      // The cold-start case: createCachedFetch's `null` default, where the gate used the
      // deployment list because no admin list had been read in this process yet.
      await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
      expect(mockedCaptureException).toHaveBeenCalledWith(failure, {
        tags: { source: 'blacklist_domains_config' },
      });
    } finally {
      select.mockRestore();
    }
  });

  test('recovery reads fresh settings again after an outage', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);

    const failure = new Error('database unavailable');
    const select = jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    } finally {
      select.mockRestore();
    }

    // A save during the outage is picked up by the next successful read, not the remembered value.
    await db
      .update(blacklisted_domains_settings)
      .set({ blocked_signup_tlds: ['top'] })
      .where(eq(blacklisted_domains_settings.id, 1));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['top']);
  });

  test('reports a later failure again once the report window passes', async () => {
    const failure = new Error('database unavailable');
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });

    await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    expect(mockedErrorLog).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + 30_000);
    await expect(getBlockedSignupTlds()).resolves.toEqual(['shop', 'top']);
    expect(mockedCaptureException).toHaveBeenCalledTimes(2);
    expect(mockedErrorLog).toHaveBeenCalledTimes(2);
  });

  test('does not report a successful read', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));

    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(mockedErrorLog).not.toHaveBeenCalled();
  });

  test('uses BLOCKED_SIGNUP_TLDS as the fallback when it is set', async () => {
    const previous = process.env.BLOCKED_SIGNUP_TLDS;
    process.env.BLOCKED_SIGNUP_TLDS = '.ASIA|xyz';
    try {
      // A dynamic import re-runs module init so `envFallbackSignupTlds` is built from the test
      // value; a static import would freeze the value the suite loaded first.
      await jest.isolateModulesAsync(async () => {
        const config = await import('@kilocode/web-shared/lib/blacklist-domains-config');
        await expect(config.getBlockedSignupTlds()).resolves.toEqual(['asia', 'xyz']);
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

  test('strips trailing dots and stores the bare label', () => {
    expect(normalizeSignupTlds(['shop.', '.shop.', 'SHOP.', '..shop..'])).toEqual(['shop']);
  });

  test('collapses a trailing-dot duplicate into one label', () => {
    expect(normalizeSignupTlds(['asia.', 'asia'])).toEqual(['asia']);
  });

  test('drops a lone dot and keeps an entry that only had a trailing dot', () => {
    expect(normalizeSignupTlds(['.', ' . '])).toEqual([]);
    expect(normalizeSignupTlds(['asia.'])).toEqual(['asia']);
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
