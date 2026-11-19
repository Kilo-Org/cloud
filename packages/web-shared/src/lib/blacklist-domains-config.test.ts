jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { blacklisted_domains, blacklisted_domains_settings } from '@kilocode/db/schema';
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
} from '@kilocode/web-shared/lib/blacklist-domains-config';

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
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
  mockedRedisGet.mockReset();
  mockedRedisSet.mockReset();
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

  test('surfaces database failures and retries immediately after recovery', async () => {
    await db.insert(blacklisted_domains_settings).values(settings(['asia']));
    const failure = new Error('database unavailable');
    const select = jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });
    mockedRedisGet.mockResolvedValue(JSON.stringify(settings(['shop'])));

    await expect(getBlockedSignupTlds()).rejects.toBe(failure);
    select.mockRestore();
    await expect(getBlockedSignupTlds()).resolves.toEqual(['asia']);
    jest.spyOn(db, 'select').mockImplementation(() => {
      throw failure;
    });
    await expect(getBlockedSignupTlds()).rejects.toBe(failure);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  test('uses BLOCKED_SIGNUP_TLDS as the fallback when it is set', async () => {
    const previous = process.env.BLOCKED_SIGNUP_TLDS;
    process.env.BLOCKED_SIGNUP_TLDS = '.ASIA|xyz';
    try {
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
