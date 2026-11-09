import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import type * as BlacklistConfig from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
  BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY,
  MAX_BLACKLIST_DOMAINS,
} from '@kilocode/worker-utils/account-access';
import { sql } from 'drizzle-orm';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
const redisGet = jest.fn<(key: string) => Promise<string | null>>();
const redisSet = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue('OK');
const after = jest.fn<(write: () => Promise<void>) => void>();
let config: typeof BlacklistConfig;
let now = 0;
let clock: jest.Spied<typeof Date.now>;
const settings = (fields = {}) =>
  JSON.stringify({
    domains: [],
    updated_at: 'version',
    updated_by: null,
    updated_by_email: null,
    ...fields,
  });

beforeAll(async () => {
  jest.doMock('@kilocode/web-shared/lib/redis', () => ({
    redisClient: { get: redisGet, set: redisSet },
  }));
  jest.doMock('next/server', () => ({ after }));
  jest.doMock('@kilocode/web-shared/lib/drizzle', () => ({ db }));
  await jest.isolateModulesAsync(async () => {
    config = await import('@kilocode/web-shared/lib/blacklist-domains-config');
  });
});

beforeEach(async () => {
  now += 10 * 60_000 + 1;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.clearAllMocks();
  redisSet.mockResolvedValue('OK');
  redisGet.mockResolvedValue(null);
  await db.delete(domain_blacklist_state).where(sql`true`);
  await db.delete(blacklisted_domains).where(sql`true`);
});

afterEach(() => clock.mockRestore());

async function initialize() {
  await db.insert(domain_blacklist_state).values({ use_env_fallback: false });
}

describe('Postgres blacklist reads', () => {
  test('refuses an uninitialized table instead of silently allowing access', async () => {
    await expect(config.getBlacklistedDomains()).rejects.toThrow('backfill');
    await expect(config.isEmailBlacklisted('user@example.com')).rejects.toThrow('backfill');
  });

  test('enumerates admin entries across bounded pages without truncating them', async () => {
    await initialize();
    const domains = Array.from(
      { length: 1005 },
      (_, index) => `domain-${String(index).padStart(4, '0')}.example`
    );
    await db.insert(blacklisted_domains).values(domains.map(domain => ({ domain })));
    await expect(config.getBlacklistedDomains()).resolves.toEqual(domains);
  });

  test('defers positive and negative lookup cache writes until after the response', async () => {
    await initialize();
    await db.insert(blacklisted_domains).values({ domain: 'blocked.example' });
    await expect(config.isEmailBlacklisted('user@sub.blocked.example')).resolves.toBe(true);
    await expect(config.isEmailBlacklisted('user@allowed.example')).resolves.toBe(false);
    expect(redisSet).not.toHaveBeenCalled();
    for (const [write] of after.mock.calls) {
      if (typeof write === 'function') await write();
    }
    expect(redisSet).toHaveBeenCalledWith(expect.any(String), '1', { ex: 60 });
    expect(redisSet).toHaveBeenCalledWith(expect.any(String), '0', { ex: 60 });
  });

  test('accepts existing lists beyond the former snapshot cap without loss', () => {
    const domains = Array.from(
      { length: MAX_BLACKLIST_DOMAINS + 1 },
      (_, index) => `${index}.example`
    );
    expect(config.BlacklistDomainsInputSchema.parse({ domains }).domains).toHaveLength(
      domains.length
    );
  });
});

describe('small shared signup/operator settings', () => {
  test('reads signup TLDs from the new settings key', async () => {
    redisGet.mockResolvedValue(settings({ blocked_signup_tlds: ['asia'] }));
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(redisGet).toHaveBeenCalledWith(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
  });

  test('uses deployment fallback when no settings config is stored', async () => {
    const expected = getEnvVariable('BLOCKED_SIGNUP_TLDS')
      ? config.normalizeSignupTlds(getEnvVariable('BLOCKED_SIGNUP_TLDS').split('|'))
      : ['shop', 'top'];
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(expected);
    expect(redisGet).toHaveBeenCalledWith(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
  });

  test('normalizes signup TLDs and retains an explicit empty override', async () => {
    redisGet.mockResolvedValue(settings({ blocked_signup_tlds: [' .ASIA ', 'asia', '.SHOP'] }));
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(['asia', 'shop']);
    now += 60_001;
    redisGet.mockResolvedValue(settings({ blocked_signup_tlds: [], updated_at: 'next' }));
    await expect(config.getBlockedSignupTlds()).resolves.toEqual([]);
    expect(config.normalizeSignupTlds(['.TOP', 'top', '..shop'])).toEqual(['top', 'shop']);
  });

  test('uses the deployment fallback only when the signup field is absent', async () => {
    redisGet.mockResolvedValue(settings());
    const expected = getEnvVariable('BLOCKED_SIGNUP_TLDS')
      ? config.normalizeSignupTlds(getEnvVariable('BLOCKED_SIGNUP_TLDS').split('|'))
      : ['shop', 'top'];
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(expected);
  });

  test('keeps the last good signup settings when Redis refresh fails', async () => {
    redisGet.mockResolvedValue(settings({ blocked_signup_tlds: ['asia'] }));
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(['asia']);
    now += 60_001;
    redisGet.mockRejectedValue(new Error('Redis timeout'));
    await expect(config.getBlockedSignupTlds()).resolves.toEqual(['asia']);
    expect(redisGet).toHaveBeenCalledWith(BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY);
  });
});
