import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
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
  const revision = randomUUID();
  await db.insert(domain_blacklist_state).values({ revision, use_env_fallback: false });
  return revision;
}

describe('Postgres blacklist management', () => {
  test('refuses an uninitialized table instead of silently allowing access', async () => {
    await expect(config.getBlacklistedDomains()).rejects.toThrow('backfill');
    await expect(config.isEmailBlacklisted('user@example.com')).rejects.toThrow('backfill');
    await expect(config.saveBlacklistedDomains(['example.com'], randomUUID())).rejects.toThrow(
      'backfill'
    );
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

  test('saves normalized entries atomically, rotates revision, and rejects stale editors', async () => {
    const revision = await initialize();
    await db.insert(blacklisted_domains).values({ domain: 'existing.example' });
    const saved = await config.saveBlacklistedDomains(
      [' EXISTING.example ', 'New.example', 'new.example'],
      revision
    );
    expect(saved.revision).not.toBe(revision);
    expect(saved.addedDomains).toEqual(['new.example']);
    await expect(config.getBlacklistedDomains()).resolves.toEqual([
      'existing.example',
      'new.example',
    ]);
    await expect(config.saveBlacklistedDomains([], revision)).rejects.toThrow('reload');
    await expect(config.getBlacklistedDomains()).resolves.toEqual([
      'existing.example',
      'new.example',
    ]);
  });

  test('clearing entries restores the existing deployment fallback semantics', async () => {
    const revision = await initialize();
    await config.saveBlacklistedDomains([], revision);
    const expected =
      getEnvVariable('BLACKLIST_DOMAINS')
        ?.split('|')
        .map(value => value.trim())
        .filter(Boolean) ?? [];
    await expect(config.getBlacklistedDomains()).resolves.toEqual(expected);
    const [state] = await db.select().from(domain_blacklist_state);
    expect(state.use_env_fallback).toBe(true);
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
    expect(
      config.BlacklistDomainsInputSchema.parse({ domains, revision: randomUUID() }).domains
    ).toHaveLength(domains.length);
  });
});

describe('small shared signup/operator settings', () => {
  test('reads only the new settings key and preserves operator metadata', async () => {
    redisGet.mockResolvedValue(
      settings({
        blocked_signup_tlds: [],
        updated_by: 'operator',
        updated_by_email: 'admin@example.com',
      })
    );
    const result = await config.getBlacklistDomainsSettings();
    expect(result.blocked_signup_tlds).toEqual([]);
    expect(result.updated_by).toBe('operator');
    expect(redisGet).toHaveBeenCalledWith(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
  });

  test('does not give an admin an empty editable config when settings are unavailable', async () => {
    await expect(config.getBlacklistDomainsSettings()).rejects.toThrow('backfill');
    redisGet.mockRejectedValue(new Error('Redis unavailable'));
    await expect(config.getBlacklistDomainsSettings()).rejects.toThrow('Redis unavailable');
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
