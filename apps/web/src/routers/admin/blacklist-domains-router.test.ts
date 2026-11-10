jest.mock('@/lib/abuse/block-blacklisted-domains', () => {
  const actual = jest.requireActual('@/lib/abuse/block-blacklisted-domains');
  return {
    ...actual,
    backfillBlockBlacklistedDomainsBatch: jest.fn(),
  };
});

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    mset: jest.fn(),
    eval: jest.fn(),
    ttl: jest.fn(),
    del: jest.fn(),
  },
}));

import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { cleanupDbForTest, db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { blacklisted_domains, kilocode_users } from '@kilocode/db';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createCallerForUser } from '@/routers/test-utils';
import { computeBlacklistStats } from '@/lib/abuse/blacklist-domain-stats';
import { isDomainOnBlacklist } from './blacklist-domains-router';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';
import type { BlockBlacklistedDomainsBackfillResponse } from '@/lib/abuse/block-blacklisted-domains';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import type { User } from '@kilocode/db/schema';
import {
  BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
  DOMAIN_BLACKLIST_GENERATION_REDIS_KEY,
  MAX_BLACKLIST_DOMAINS,
  type BlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import {
  envFallbackDomains,
  envFallbackSignupTlds,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
  normalizeSignupTlds,
} from '@kilocode/web-shared/lib/blacklist-domains-config';

type BackfillBatch = (params: {
  actorId: string;
  domains: string[];
}) => Promise<BlockBlacklistedDomainsBackfillResponse>;

const actualBackfillModule = jest.requireActual<{
  backfillBlockBlacklistedDomainsBatch: BackfillBatch;
}>('@/lib/abuse/block-blacklisted-domains');
const mockedBackfill = jest.mocked(backfillBlockBlacklistedDomainsBatch);
const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisMset = jest.mocked(redisClient.mset);
const mockedRedisEval = jest.mocked(redisClient.eval);
const redisValues = new Map<string, string>();
const redisTtls = new Map<string, number>();
const redisReadSettingsPresence: { key: string; smallSettingsPresent: boolean }[] = [];
const initialSettings: BlacklistDomainsConfig = {
  domains: [],
  blocked_signup_tlds: ['shop', 'top'],
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
};
const conflictMessage = 'Blacklist changed. Reload the complete list before saving.';
const originalEnvFallbackDomains = [...envFallbackDomains];

let admin: User;

function contentVersion(config: BlacklistDomainsConfig) {
  return createHash('sha256')
    .update(
      `postgres:${JSON.stringify({
        domains: config.domains,
        blocked_signup_tlds: config.blocked_signup_tlds,
        updated_at: config.updated_at,
        updated_by: config.updated_by,
        updated_by_email: config.updated_by_email,
      })}`
    )
    .digest('hex');
}

async function configVersion() {
  const settings: BlacklistDomainsConfig = JSON.parse(
    redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ??
      redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ??
      JSON.stringify(DEFAULT_BLACKLIST_DOMAINS_CONFIG)
  );
  const rows = await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain);
  return contentVersion({ ...settings, domains: rows.map(row => row.domain) });
}

async function setPostgresBlacklist(domains: string[]) {
  await db.delete(blacklisted_domains).where(sql`true`);
  for (let offset = 0; offset < domains.length; offset += 1000) {
    await db
      .insert(blacklisted_domains)
      .values(domains.slice(offset, offset + 1000).map(domain => ({ domain })));
  }
}

async function refreshCache(_script: string, keys: string[], args: unknown[]) {
  expect(keys).toEqual([DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, BLACKLIST_DOMAINS_REDIS_KEY]);
  expect(args).toEqual([expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)]);
  const [generation] = args;
  if (typeof generation !== 'string') throw new Error('Expected string generation');
  redisValues.set(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, generation);
  const ttl = redisValues.has(BLACKLIST_DOMAINS_REDIS_KEY)
    ? (redisTtls.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? -1)
    : -2;
  if (ttl !== -1) return 0;
  redisValues.delete(BLACKLIST_DOMAINS_REDIS_KEY);
  redisTtls.delete(BLACKLIST_DOMAINS_REDIS_KEY);
  return 1;
}

beforeEach(async () => {
  await cleanupDbForTest();
  redisValues.clear();
  redisTtls.clear();
  redisReadSettingsPresence.length = 0;
  envFallbackDomains.splice(0, envFallbackDomains.length, ...originalEnvFallbackDomains);
  redisValues.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(initialSettings));
  mockedRedisGet.mockReset();
  mockedRedisGet.mockImplementation(async <T>(key: string) => {
    redisReadSettingsPresence.push({
      key,
      smallSettingsPresent: redisValues.has(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY),
    });
    return (redisValues.get(key) ?? null) as T | null;
  });
  mockedRedisMset.mockReset();
  mockedRedisMset.mockImplementation(async values => {
    for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
    return 'OK';
  });
  mockedRedisEval.mockReset();
  mockedRedisEval.mockImplementation(refreshCache);
  jest.mocked(redisClient.ttl).mockReset();
  jest.mocked(redisClient.del).mockReset();
  mockedBackfill.mockReset();
  mockedBackfill.mockImplementation(actualBackfillModule.backfillBlockBlacklistedDomainsBatch);
  admin = await insertTestUser({
    google_user_email: `admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

afterEach(() => {
  envFallbackDomains.splice(0, envFallbackDomains.length, ...originalEnvFallbackDomains);
  for (const read of redisReadSettingsPresence.filter(
    ({ key }) => key === BLACKLIST_DOMAINS_REDIS_KEY
  )) {
    expect(read.smallSettingsPresent).toBe(false);
  }
  expect(redisClient.ttl).not.toHaveBeenCalled();
  expect(redisClient.del).not.toHaveBeenCalled();
  for (const [values] of mockedRedisMset.mock.calls) {
    expect(Object.keys(values).sort()).toEqual(
      [BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY].sort()
    );
    expect(JSON.parse(String(values[BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY])).domains).toEqual([]);
  }
  for (const [script, keys, args] of mockedRedisEval.mock.calls) {
    expect(keys).toEqual([DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, BLACKLIST_DOMAINS_REDIS_KEY]);
    expect(args).toEqual([expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)]);
    expect(script).toMatch(/redis\.call\(\s*['"]SET['"]\s*,\s*KEYS\[1\]\s*,\s*ARGV\[1\]\s*\)/i);
    expect(script).toMatch(/redis\.call\(\s*['"]TTL['"]\s*,\s*KEYS\[2\]\s*\)\s*==\s*-1/i);
    expect(script).toMatch(/then\s+return\s+redis\.call\(\s*['"]DEL['"]\s*,\s*KEYS\[2\]\s*\)/i);
    expect(script.search(/redis\.call\(\s*['"]SET['"]/i)).toBeLessThan(
      script.search(/redis\.call\(\s*['"]TTL['"]/i)
    );
    expect(script).not.toMatch(/EXPIRE|PERSIST/i);
  }
  jest.restoreAllMocks();
});

describe('isDomainOnBlacklist', () => {
  it('matches exact equality', () => {
    expect(isDomainOnBlacklist('mailinator.com', ['mailinator.com'])).toBe(true);
  });

  it('matches subdomains of blacklist entries', () => {
    expect(isDomainOnBlacklist('evil.mailinator.com', ['mailinator.com'])).toBe(true);
    expect(isDomainOnBlacklist('a.b.mailinator.com', ['mailinator.com'])).toBe(true);
  });

  it('is case-insensitive on the domain side', () => {
    expect(isDomainOnBlacklist('MAILINATOR.COM', ['mailinator.com'])).toBe(true);
  });

  it('does not match unrelated domains', () => {
    expect(isDomainOnBlacklist('legit.com', ['mailinator.com'])).toBe(false);
  });

  it('does not match on label-boundary mismatch', () => {
    expect(isDomainOnBlacklist('notmailinator.com', ['mailinator.com'])).toBe(false);
  });

  it('returns false on empty blacklist', () => {
    expect(isDomainOnBlacklist('anything.com', [])).toBe(false);
  });
});

describe('computeBlacklistStats', () => {
  it('sums per-host counts for each blacklist entry by exact match', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com', 'spam.org'],
      [
        { email_host: 'mailinator.com', has_local_part: true, count: 12 },
        { email_host: 'spam.org', has_local_part: true, count: 5 },
        { email_host: 'legit.com', has_local_part: true, count: 99 },
      ]
    );

    expect(stats.domains).toEqual([
      { domain: 'mailinator.com', blockedCount: 12 },
      { domain: 'spam.org', blockedCount: 5 },
    ]);
    expect(stats.totalDomains).toBe(2);
    expect(stats.totalBlockedUsers).toBe(17);
  });

  it('includes subdomain groups in the count for a blacklist entry', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com'],
      [
        { email_host: 'mailinator.com', has_local_part: true, count: 4 },
        { email_host: 'evil.mailinator.com', has_local_part: true, count: 3 },
        { email_host: 'a.b.mailinator.com', has_local_part: true, count: 2 },
        { email_host: 'notmailinator.com', has_local_part: true, count: 100 },
      ]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 9 }]);
    expect(stats.totalBlockedUsers).toBe(9);
  });

  it('orders result by blockedCount descending', () => {
    const stats = computeBlacklistStats(
      ['first.com', 'second.com', 'third.com'],
      [
        { email_host: 'first.com', has_local_part: true, count: 1 },
        { email_host: 'second.com', has_local_part: true, count: 10 },
        { email_host: 'third.com', has_local_part: true, count: 5 },
      ]
    );

    expect(stats.domains.map(d => d.domain)).toEqual(['second.com', 'third.com', 'first.com']);
  });

  it('caps the returned rows while keeping the full domain total', () => {
    const stats = computeBlacklistStats(
      ['first.com', 'second.com', 'third.com'],
      [
        { email_host: 'first.com', has_local_part: true, count: 1 },
        { email_host: 'second.com', has_local_part: true, count: 10 },
        { email_host: 'third.com', has_local_part: true, count: 5 },
      ],
      2
    );

    expect(stats.domains).toEqual([
      { domain: 'second.com', blockedCount: 10 },
      { domain: 'third.com', blockedCount: 5 },
    ]);
    expect(stats.totalDomains).toBe(3);
    expect(stats.totalBlockedUsers).toBe(16);
  });

  it('ignores rows with a null host', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com'],
      [
        { email_host: null, has_local_part: true, count: 999 },
        { email_host: 'mailinator.com', has_local_part: true, count: 3 },
      ]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 3 }]);
  });

  it('returns zero-count entries for blacklist entries with no matching users', () => {
    const stats = computeBlacklistStats(
      ['unused.com'],
      [{ email_host: 'other.com', has_local_part: true, count: 10 }]
    );

    expect(stats.domains).toEqual([{ domain: 'unused.com', blockedCount: 0 }]);
    expect(stats.totalBlockedUsers).toBe(0);
  });

  it('counts one group once for each matching entry, including nested entries', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com', 'sub.mailinator.com'],
      [{ email_host: 'sub.mailinator.com', has_local_part: true, count: 3 }]
    );

    expect(stats.domains).toEqual([
      { domain: 'mailinator.com', blockedCount: 3 },
      { domain: 'sub.mailinator.com', blockedCount: 3 },
    ]);
    expect(stats.totalBlockedUsers).toBe(6);
  });

  it('credits an address without @ only through a dotted entry', () => {
    const stats = computeBlacklistStats(
      ['deep.spam.org', 'spam.org'],
      [{ email_host: 'deep.spam.org', has_local_part: false, count: 2 }]
    );

    expect(stats.domains).toEqual([
      { domain: 'spam.org', blockedCount: 2 },
      { domain: 'deep.spam.org', blockedCount: 0 },
    ]);
  });

  it('does not match a group whose label boundary differs from the entry', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com'],
      [{ email_host: 'notmailinator.com', has_local_part: true, count: 50 }]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 0 }]);
  });

  it('returns empty stats for an empty blacklist', () => {
    const stats = computeBlacklistStats(
      [],
      [{ email_host: 'anything.com', has_local_part: true, count: 5 }]
    );

    expect(stats.domains).toEqual([]);
    expect(stats.totalDomains).toBe(0);
    expect(stats.totalBlockedUsers).toBe(0);
  });
});

describe('admin.blacklistDomains.stats', () => {
  it('returns structurally valid shape for an empty blacklist', async () => {
    await insertTestUser({ google_user_email: 'a@example.com', email_domain: 'example.com' });
    await setPostgresBlacklist([]);

    const caller = await createCallerForUser(admin.id);
    const stats = await caller.admin.blacklistDomains.stats();

    expect(stats).toMatchObject({
      domains: expect.any(Array),
      totalDomains: expect.any(Number),
      totalBlockedUsers: expect.any(Number),
    });
    expect(stats.domains).toEqual([]);
    expect(stats.totalDomains).toBe(0);
    expect(stats.totalBlockedUsers).toBe(0);
  });
});

describe('admin.blacklistDomains.suspicious', () => {
  it('aggregates user counts by email_domain and returns blocked counts and percent', async () => {
    await insertTestUser({ google_user_email: 'a@example.com', email_domain: 'example.com' });
    await insertTestUser({ google_user_email: 'b@example.com', email_domain: 'example.com' });
    await insertTestUser({
      google_user_email: 'c@example.com',
      email_domain: 'example.com',
      blocked_reason: 'abuse',
    });
    await insertTestUser({
      google_user_email: 'x@spam.org',
      email_domain: 'spam.org',
      blocked_reason: 'abuse',
    });
    await insertTestUser({
      google_user_email: 'y@spam.org',
      email_domain: 'spam.org',
      blocked_reason: 'abuse',
    });
    await setPostgresBlacklist(['example.com', 'spam.org']);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const byDomain = Object.fromEntries(domains.map(d => [d.domain, d]));
    expect(byDomain['example.com']).toMatchObject({
      accountCount: 3,
      blockedAccountCount: 1,
      blockedAccountPercent: 33.33,
    });
    expect(byDomain['spam.org']).toMatchObject({
      accountCount: 2,
      blockedAccountCount: 2,
      blockedAccountPercent: 100,
    });
  });

  it('orders rows by blocked_account_count desc then account_count desc', async () => {
    for (let i = 0; i < 2; i++) {
      await insertTestUser({
        google_user_email: `u${i}@more-blocked.com`,
        email_domain: 'more-blocked.com',
      });
      await insertTestUser({
        google_user_email: `b${i}@more-blocked.com`,
        email_domain: 'more-blocked.com',
        blocked_reason: 'abuse',
      });
    }
    await insertTestUser({
      google_user_email: 'u@fewer-blocked.com',
      email_domain: 'fewer-blocked.com',
    });
    await insertTestUser({
      google_user_email: 'b@fewer-blocked.com',
      email_domain: 'fewer-blocked.com',
      blocked_reason: 'abuse',
    });
    await setPostgresBlacklist(['more-blocked.com', 'fewer-blocked.com']);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const ordered = domains.map(d => d.domain);
    expect(ordered.indexOf('more-blocked.com')).toBeLessThan(ordered.indexOf('fewer-blocked.com'));
  });

  it('hides domains with fewer than 30% of accounts blocked', async () => {
    for (let i = 0; i < 10; i++) {
      await insertTestUser({ google_user_email: `u${i}@noisy.com`, email_domain: 'noisy.com' });
    }
    for (let i = 0; i < 8; i++) {
      await insertTestUser({
        google_user_email: `u${i}@under-threshold.com`,
        email_domain: 'under-threshold.com',
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertTestUser({
        google_user_email: `b${i}@under-threshold.com`,
        email_domain: 'under-threshold.com',
        blocked_reason: 'abuse',
      });
    }
    for (let i = 0; i < 7; i++) {
      await insertTestUser({
        google_user_email: `u${i}@over-threshold.com`,
        email_domain: 'over-threshold.com',
      });
    }
    for (let i = 0; i < 3; i++) {
      await insertTestUser({
        google_user_email: `b${i}@over-threshold.com`,
        email_domain: 'over-threshold.com',
        blocked_reason: 'abuse',
      });
    }
    await setPostgresBlacklist(['noisy.com', 'under-threshold.com', 'over-threshold.com']);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const names = domains.map(d => d.domain);
    expect(names).toContain('over-threshold.com');
    expect(names).not.toContain('noisy.com');
    expect(names).not.toContain('under-threshold.com');
  });

  it('includes domains below the blocked-percent threshold when provider filtering is disabled', async () => {
    for (let i = 0; i < 9; i++) {
      await insertTestUser({ google_user_email: `u${i}@hotmail.com`, email_domain: 'hotmail.com' });
    }
    await insertTestUser({
      google_user_email: 'blocked@hotmail.com',
      email_domain: 'hotmail.com',
      blocked_reason: 'abuse',
    });
    await setPostgresBlacklist(['hotmail.com']);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious({
      hideLegitimateProviders: false,
    });

    expect(domains.map(d => d.domain)).toContain('hotmail.com');
  });

  it('excludes users whose email_domain is NULL', async () => {
    await insertTestUser({ google_user_email: 'a@example.com', email_domain: null });
    await setPostgresBlacklist([]);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    expect(domains).toHaveLength(0);
  });

  it('returns first_seen and last_seen timestamps', async () => {
    await insertTestUser({
      google_user_email: 'a@example.com',
      email_domain: 'example.com',
      blocked_reason: 'abuse',
    });
    await setPostgresBlacklist(['example.com']);

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const example = domains.find(d => d.domain === 'example.com');
    expect(example).toMatchObject({ firstSeen: expect.any(String), lastSeen: expect.any(String) });
  });
});

describe('admin.blacklistDomains.set', () => {
  it('bootstraps settings from legacy on save and stops reading legacy after commit', async () => {
    await setPostgresBlacklist(['previous.example']);
    redisValues.delete(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: ['stale-legacy.example'],
        blocked_signup_tlds: [' .ASIA ', 'asia'],
        updated_at: 'legacy-time',
        updated_by: 'legacy-admin',
        updated_by_email: 'legacy-admin@example.com',
      })
    );
    redisTtls.set(BLACKLIST_DOMAINS_REDIS_KEY, -1);
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();

    expect(loaded).toMatchObject({
      domains: ['previous.example'],
      blocked_signup_tlds: ['asia'],
      updated_at: 'legacy-time',
      updated_by: 'legacy-admin',
      updated_by_email: 'legacy-admin@example.com',
    });
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(
      mockedRedisGet.mock.calls.filter(([key]) => key === BLACKLIST_DOMAINS_REDIS_KEY)
    ).toHaveLength(1);

    const transaction = db.transaction.bind(db);
    const order: string[] = [];
    jest.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      const result = await transaction(callback);
      order.push('commit');
      return result;
    });
    mockedRedisMset.mockImplementationOnce(async values => {
      order.push('mset');
      for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
      return 'OK';
    });
    mockedRedisEval.mockImplementationOnce(async (...args) => {
      order.push('refresh');
      expect(order).toEqual(['mset', 'commit', 'refresh']);
      expect(redisValues.has(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(false);
      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
      const persisted = JSON.parse(
        redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null'
      );
      expect(persisted).toEqual({
        domains: [],
        blocked_signup_tlds: ['asia'],
        updated_at: expect.any(String),
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      });
      expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(persisted.updated_at);
      return refreshCache(...args);
    });

    const saved = await caller.admin.blacklistDomains.set({
      domains: loaded.domains,
      expected_version: loaded.version,
    });

    expect(saved.blocked_signup_tlds).toEqual(['asia']);
    expect(saved.cache_refresh_failed).toBe(false);
    expect(saved).not.toHaveProperty('legacy_cleanup_failed');
    expect(redisValues.get(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(
      mockedRedisEval.mock.calls[0][2][0]
    );
    expect(redisValues.has(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(false);
    expect(order).toEqual(['mset', 'commit', 'refresh']);

    const afterSave = await caller.admin.blacklistDomains.get();
    expect(afterSave).toMatchObject({
      domains: ['previous.example'],
      blocked_signup_tlds: ['asia'],
      updated_by: admin.id,
    });
    await caller.admin.blacklistDomains.set({
      domains: afterSave.domains,
      expected_version: afterSave.version,
    });
    expect(
      mockedRedisGet.mock.calls.filter(([key]) => key === BLACKLIST_DOMAINS_REDIS_KEY)
    ).toHaveLength(2);
  });

  it('blocks existing accounts on a newly added domain and writes only small settings', async () => {
    const target = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      api_token_pepper: 'initial-pepper',
    });
    const safe = await insertTestUser({
      google_user_email: 'b@legit.com',
      email_domain: 'legit.com',
      api_token_pepper: 'safe-pepper',
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: await configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(result.cache_refresh_failed).toBe(false);
    expect(mockedRedisMset).toHaveBeenCalledWith({
      [BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY]: JSON.stringify({
        domains: [],
        blocked_signup_tlds: result.blocked_signup_tlds,
        updated_at: result.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      }),
      [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: result.updated_at,
    });
    expect(result.updated_at).toEqual(expect.any(String));
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'mailinator.com' }]);
    expect(mockedRedisEval).toHaveBeenCalledTimes(1);

    const rows = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [target.id, safe.id]));
    const byId = new Map(rows.map(row => [row.id, row]));
    const blocked = byId.get(target.id);
    expect(blocked?.blocked_reason).toBe('domainblocked');
    expect(blocked?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(blocked?.api_token_pepper).not.toBe('initial-pepper');
    const untouched = byId.get(safe.id);
    expect(untouched?.blocked_reason).toBeNull();
    expect(untouched?.api_token_pepper).toBe('safe-pepper');
  });

  it('versions the actual domain and operator metadata after nonempty and empty saves', async () => {
    const caller = await createCallerForUser(admin.id);
    const beforeVersion = await configVersion();
    const populated = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: beforeVersion,
    });
    const populatedConfig = await caller.admin.blacklistDomains.get();
    expect(populatedConfig.version).toBe(contentVersion(populated));
    expect(populatedConfig.version).not.toBe(beforeVersion);

    const emptied = await caller.admin.blacklistDomains.set({
      domains: [],
      expected_version: populatedConfig.version,
    });
    const emptyConfig = await caller.admin.blacklistDomains.get();
    expect(emptyConfig.version).toBe(contentVersion(emptied));
    expect(emptyConfig.version).not.toBe(populatedConfig.version);
    expect(populated.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(emptied.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(emptyConfig.domains).toEqual([]);
  });

  it('allows an identical snapshot saved within the same millisecond to keep its content hash', async () => {
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-11-10T09:00:00.000Z');
    const caller = await createCallerForUser(admin.id);
    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: await configVersion(),
    });
    const loaded = await caller.admin.blacklistDomains.get();
    mockedBackfill.mockClear();

    const saved = await caller.admin.blacklistDomains.set({
      domains: loaded.domains,
      expected_version: loaded.version,
    });

    expect(contentVersion(saved)).toBe(loaded.version);
    expect((await caller.admin.blacklistDomains.get()).version).toBe(loaded.version);
    expect(saved.cache_refresh_failed).toBe(false);
    expect(mockedRedisEval).toHaveBeenCalledTimes(2);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('replaces the full normalized PG snapshot but only backfills actual additions', async () => {
    await setPostgresBlacklist(['mailinator.com', 'removed.example']);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({ domains: ['spam.org'], blocked_signup_tlds: ['legacy'] })
    );
    const existing = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: [' MAILINATOR.COM ', 'Spam.ORG', 'spam.org', '   '],
      expected_version: await configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com', 'spam.org']);
    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      [{ domain: 'mailinator.com' }, { domain: 'spam.org' }]
    );
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, existing.id));
    expect(row.blocked_reason).toBeNull();
  });

  it('compares additions with stored PG rows even while env fallback is enabled', async () => {
    envFallbackDomains.splice(0, envFallbackDomains.length, 'fallback-only.example');
    const domains = [...new Set([...envFallbackDomains, 'added.example'])];
    await setPostgresBlacklist([]);
    const caller = await createCallerForUser(admin.id);

    await caller.admin.blacklistDomains.set({ domains, expected_version: await configVersion() });

    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains });
    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      [...domains].sort().map(domain => ({ domain }))
    );
  });

  it.each([{ domains: ['mailinator.com'] }, { domains: [] }])(
    'removes PG domains without backfilling and preserves small settings: $domains',
    async ({ domains }) => {
      await setPostgresBlacklist(['mailinator.com', 'removed.example']);
      redisValues.set(
        BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
        JSON.stringify({ ...initialSettings, blocked_signup_tlds: ['asia'] })
      );
      const caller = await createCallerForUser(admin.id);
      const result = await caller.admin.blacklistDomains.set({
        domains,
        expected_version: await configVersion(),
      });

      expect(result.domains).toEqual(domains);
      expect(await db.select().from(blacklisted_domains)).toEqual(
        domains.map(domain => ({ domain }))
      );
      expect(JSON.parse(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')).toEqual(
        {
          domains: [],
          blocked_signup_tlds: ['asia'],
          updated_at: result.updated_at,
          updated_by: admin.id,
          updated_by_email: admin.google_user_email,
        }
      );
      expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(result.updated_at);
      expect(mockedBackfill).not.toHaveBeenCalled();
    }
  );

  it('finishes SQL before MSET, then commits before generation refresh and backfill', async () => {
    const transaction = db.transaction.bind(db);
    const order: string[] = [];
    let savingTransaction: DrizzleTransaction | undefined;
    jest.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
      const result = await transaction(async tx => {
        savingTransaction = tx;
        return callback(tx);
      });
      order.push('commit');
      return result;
    });
    mockedRedisMset.mockImplementationOnce(async values => {
      order.push('mset');
      expect(mockedRedisEval).not.toHaveBeenCalled();
      expect(redisValues.has(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(false);
      if (!savingTransaction) throw new Error('Expected active save transaction');
      expect(await savingTransaction.select().from(blacklisted_domains)).toEqual([
        { domain: 'mailinator.com' },
      ]);
      expect(await db.select().from(blacklisted_domains)).toEqual([]);
      for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
      return 'OK';
    });
    mockedRedisEval.mockImplementationOnce(async (...args) => {
      order.push('refresh');
      expect(order).toEqual(['mset', 'commit', 'refresh']);
      expect(redisValues.has(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(false);
      const committed = await db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE NOWAIT`);
        return tx.select().from(blacklisted_domains);
      });
      expect(committed).toEqual([{ domain: 'mailinator.com' }]);
      return refreshCache(...args);
    });
    mockedBackfill.mockImplementationOnce(async () => {
      order.push('backfill');
      return { processed: 0, remaining: false };
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: await configVersion(),
    });

    expect(order).toEqual(['mset', 'commit', 'refresh', 'backfill']);
    expect(redisValues.get(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(
      mockedRedisEval.mock.calls[0][2][0]
    );
  });

  it.each([-2, -1, 0, 1, 300])(
    'atomically refreshes generation and deletes only a persistent legacy key with TTL %i',
    async ttl => {
      const legacy = 'invalid legacy JSON that must not be read';
      if (ttl !== -2) {
        redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, legacy);
        redisTtls.set(BLACKLIST_DOMAINS_REDIS_KEY, ttl);
      }
      const caller = await createCallerForUser(admin.id);

      const result = await caller.admin.blacklistDomains.set({
        domains: [],
        expected_version: await configVersion(),
      });

      expect(result.cache_refresh_failed).toBe(false);
      expect(mockedRedisEval).toHaveBeenCalledTimes(1);
      expect(redisValues.get(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(
        mockedRedisEval.mock.calls[0][2][0]
      );
      if (ttl === -1 || ttl === -2) {
        expect(redisValues.has(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(false);
        expect(redisTtls.has(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(false);
      } else {
        expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(legacy);
        expect(redisTtls.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(ttl);
      }
    }
  );

  it('reports cache refresh failure without failing the committed save or skipping account backfill', async () => {
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'not-json');
    redisValues.set(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, 'previous-generation');
    mockedRedisEval.mockRejectedValueOnce(new Error('cache refresh unavailable'));
    const target = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const beforeVersion = await configVersion();
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: beforeVersion,
    });

    expect(result.cache_refresh_failed).toBe(true);
    expect(result).not.toHaveProperty('legacy_cleanup_failed');
    expect(redisValues.get(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe('previous-generation');
    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(await configVersion()).not.toBe(beforeVersion);
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'mailinator.com' }]);
    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('not-json');
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['mailinator.com'] });
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, target.id));
    expect(row.blocked_reason).toBe('domainblocked');
  });

  it('keeps the saved list and cache refresh success when the automatic block fails', async () => {
    mockedBackfill.mockRejectedValueOnce(new Error('database unavailable'));
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: await configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: true });
    expect(result.cache_refresh_failed).toBe(false);
    expect(mockedRedisEval).toHaveBeenCalledTimes(1);
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'mailinator.com' }]);
  });

  it('rejects a stale PG content hash before mutating either store or refreshing cache', async () => {
    await setPostgresBlacklist(['first.example', 'second.example']);
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    const currentDomains = [...loaded.domains, 'third.example'];
    await setPostgresBlacklist(currentDomains);
    const settingsBefore = redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'not-json');
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementationOnce(callback =>
      transaction(async tx => {
        const deletion = jest.spyOn(tx, 'delete');
        const insertion = jest.spyOn(tx, 'insert');
        const update = jest.spyOn(tx, 'update');
        try {
          return await callback(tx);
        } finally {
          expect(deletion).not.toHaveBeenCalled();
          expect(insertion).not.toHaveBeenCalled();
          expect(update).not.toHaveBeenCalled();
        }
      })
    );

    await expect(
      caller.admin.blacklistDomains.set({
        domains: loaded.domains,
        blocked_tlds: ['shop'],
        expected_version: loaded.version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      currentDomains.map(domain => ({ domain }))
    );
    expect(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(settingsBefore);
    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('not-json');
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('rejects a legacy raw-JSON hash even when it matches the untouched legacy key', async () => {
    const legacy = JSON.stringify({ ...initialSettings, domains: ['previous.example'] });
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, legacy);
    await setPostgresBlacklist(['previous.example']);
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: [],
        expected_version: createHash('sha256').update(legacy).digest('hex'),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('rejects an editor without expected_version before reading or writing Redis', async () => {
    await setPostgresBlacklist(['tail.example']);
    const caller = await createCallerForUser(admin.id);
    const oldInput = { domains: ['prefix.example'], blocked_tlds: ['shop'] };

    await expect(
      caller.admin.blacklistDomains.set(
        oldInput as Parameters<typeof caller.admin.blacklistDomains.set>[0]
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'tail.example' }]);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('preserves PG rows and skips cache refresh/backfill when MSET fails', async () => {
    await setPostgresBlacklist(['previous.example']);
    const versionBefore = await configVersion();
    const settingsBefore = redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'legacy');
    mockedRedisMset.mockRejectedValueOnce(new Error('redis write failed'));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: await configVersion(),
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(await configVersion()).toBe(versionBefore);
    expect(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(settingsBefore);
    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('legacy');
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('hashes actual PG rows with applied metadata after an ambiguous MSET and requires a reload', async () => {
    await setPostgresBlacklist(['previous.example']);
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'untouched legacy');
    mockedRedisMset.mockImplementationOnce(async values => {
      for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
      throw new Error('Redis applied MSET but its response was lost');
    });
    const caller = await createCallerForUser(admin.id);
    const input = {
      domains: ['new.example', 'previous.example'],
      blocked_tlds: ['asia'],
      expected_version: await configVersion(),
    };

    await expect(caller.admin.blacklistDomains.set(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('untouched legacy');
    const liveSettings = JSON.parse(
      redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null'
    );
    expect(liveSettings).toEqual({
      domains: [],
      blocked_signup_tlds: ['asia'],
      updated_at: expect.any(String),
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
    });
    expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(liveSettings.updated_at);
    const loaded = await caller.admin.blacklistDomains.get();
    expect(loaded.version).not.toBe(input.expected_version);
    expect(loaded.version).toBe(contentVersion({ ...liveSettings, domains: ['previous.example'] }));
    expect(loaded.domains).toEqual(['previous.example']);

    await expect(caller.admin.blacklistDomains.set(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: conflictMessage,
    });
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedRedisEval).not.toHaveBeenCalled();
    const result = await caller.admin.blacklistDomains.set({
      ...input,
      expected_version: loaded.version,
    });
    expect(result.domains).toEqual(input.domains);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['new.example'] });
    expect(mockedRedisMset).toHaveBeenCalledTimes(2);
    expect(mockedRedisEval).toHaveBeenCalledTimes(1);
    expect(await configVersion()).not.toBe(input.expected_version);
  });

  it.each([false, true])(
    'never refreshes cache or backfills after a commit error, including ambiguous ACK: %s',
    async commitApplied => {
      await setPostgresBlacklist(['previous.example']);
      const beforeVersion = await configVersion();
      const transaction = db.transaction.bind(db);
      redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'legacy');
      const caller = await createCallerForUser(admin.id);
      jest.spyOn(db, 'transaction').mockImplementationOnce(async callback => {
        if (commitApplied) {
          await transaction(callback);
        } else {
          await transaction(async tx => {
            await callback(tx);
            throw new Error('commit rejected');
          });
        }
        throw new Error('commit acknowledgement lost');
      });

      await expect(
        caller.admin.blacklistDomains.set({
          domains: ['new.example'],
          expected_version: beforeVersion,
        })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

      expect(mockedRedisMset).toHaveBeenCalledTimes(1);
      expect(mockedRedisEval).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
      expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('legacy');
      expect(await db.select().from(blacklisted_domains)).toEqual([
        { domain: commitApplied ? 'new.example' : 'previous.example' },
      ]);
      const loaded = await caller.admin.blacklistDomains.get();
      const liveSettings: BlacklistDomainsConfig = JSON.parse(
        redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null'
      );
      expect(loaded.version).toBe(
        contentVersion({
          ...liveSettings,
          domains: [commitApplied ? 'new.example' : 'previous.example'],
        })
      );
      expect(loaded.version).not.toBe(beforeVersion);
      expect(redisValues.has(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY)).toBe(false);
    }
  );

  it('rolls back a second SQL batch failure before Redis and backfills additions on retry', async () => {
    await setPostgresBlacklist(['previous.example']);
    const versionBefore = await configVersion();
    const settingsBefore = redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'legacy');
    const addedDomains = Array.from({ length: 1001 }, (_, i) => `batch${i}.example`);
    const domains = ['previous.example', ...addedDomains];
    const existing = await insertTestUser({
      google_user_email: 'existing@previous.example',
      email_domain: 'previous.example',
    });
    const target = await insertTestUser({
      google_user_email: 'target@batch1000.example',
      email_domain: 'batch1000.example',
    });
    const input = { domains, expected_version: await configVersion() };
    const caller = await createCallerForUser(admin.id);
    await db.execute(sql`
      CREATE FUNCTION public.fail_blacklist_second_batch() RETURNS trigger AS $$
      BEGIN
        IF (SELECT count(*) FROM public.blacklisted_domains) = 1000 THEN
          RAISE EXCEPTION 'forced second blacklist batch failure';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_blacklist_second_batch
        BEFORE INSERT ON public.blacklisted_domains
        FOR EACH STATEMENT EXECUTE FUNCTION public.fail_blacklist_second_batch();
    `);
    try {
      await expect(caller.admin.blacklistDomains.set(input)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        cause: { cause: { message: 'forced second blacklist batch failure' } },
      });

      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
      expect(await configVersion()).toBe(versionBefore);
      expect(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(settingsBefore);
      expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe('legacy');
      expect(mockedRedisMset).not.toHaveBeenCalled();
      expect(mockedRedisEval).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`
        DROP TRIGGER fail_blacklist_second_batch ON public.blacklisted_domains;
        DROP FUNCTION public.fail_blacklist_second_batch();
      `);
    }
    const result = await caller.admin.blacklistDomains.set(input);

    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedRedisEval).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: addedDomains });
    expect(await db.select({ count: count() }).from(blacklisted_domains)).toEqual([
      { count: domains.length },
    ]);
    const rows = await db
      .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [existing.id, target.id]));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: existing.id, blocked_reason: null },
        { id: target.id, blocked_reason: 'domainblocked' },
      ])
    );
  });

  it('serializes saves under EXCLUSIVE table locks and rejects a stale concurrent content hash', async () => {
    const writingFirst = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    mockedRedisMset.mockImplementationOnce(async values => {
      writingFirst.resolve();
      await releaseFirst.promise;
      for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
      return 'OK';
    });
    mockedBackfill.mockResolvedValue({ processed: 0, remaining: false });
    const caller = await createCallerForUser(admin.id);
    const expectedVersion = await configVersion();
    const first = caller.admin.blacklistDomains.set({
      domains: ['first.example'],
      blocked_tlds: ['asia'],
      expected_version: expectedVersion,
    });
    const saves = [first];
    try {
      await Promise.race([
        writingFirst.promise,
        first.then(() => {
          throw new Error('Save finished without reaching Redis');
        }),
      ]);
      const second = caller.admin.blacklistDomains.set({
        domains: ['first.example', 'second.example'],
        expected_version: expectedVersion,
      });
      saves.push(second);
      const secondFailure = expect(second).rejects.toMatchObject({
        code: 'CONFLICT',
        message: conflictMessage,
      });
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const { rows } = await db.execute<{ granted: boolean }>(sql`
          SELECT granted FROM pg_locks
          WHERE relation = 'public.blacklisted_domains'::regclass
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND mode = 'ExclusiveLock'
        `);
        if (rows.some(row => row.granted) && rows.some(row => !row.granted)) {
          waiting = true;
          break;
        }
      }
      expect(waiting).toBe(true);
      expect(mockedRedisGet).toHaveBeenCalledTimes(1);
      expect(mockedRedisMset).toHaveBeenCalledTimes(1);
      expect(mockedRedisEval).not.toHaveBeenCalled();
      expect(await db.select().from(blacklisted_domains)).toEqual([]);
      releaseFirst.resolve();
      const firstResult = await first;
      await secondFailure;

      expect(firstResult.blocked_signup_tlds).toEqual(['asia']);
      expect(mockedRedisMset).toHaveBeenCalledTimes(1);
      expect(mockedRedisEval).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledWith({
        actorId: admin.id,
        domains: ['first.example'],
      });
      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'first.example' }]);
      expect(JSON.parse(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')).toEqual(
        {
          domains: [],
          blocked_signup_tlds: ['asia'],
          updated_at: firstResult.updated_at,
          updated_by: admin.id,
          updated_by_email: admin.google_user_email,
        }
      );
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(saves);
    }
  }, 15000);

  it('stores normalized signup TLDs and never backfills on a TLD change', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@example.asia',
      email_domain: 'example.asia',
    });
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: [],
      blocked_tlds: ['  .ASIA  ', 'shop', 'asia'],
      expected_version: await configVersion(),
    });

    expect(result.blocked_signup_tlds).toEqual(['asia', 'shop']);
    expect(
      JSON.parse(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')
        .blocked_signup_tlds
    ).toEqual(['asia', 'shop']);
    expect(mockedBackfill).not.toHaveBeenCalled();
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBeNull();
  });

  it.each([undefined, [], [' .ASIA ', 'asia', 'SHOP']])(
    'preserves the normalized small-settings TLD field or env fallback when omitted: %j',
    async blockedSignupTlds => {
      redisValues.set(
        BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
        JSON.stringify({ ...initialSettings, blocked_signup_tlds: blockedSignupTlds })
      );
      redisValues.set(
        BLACKLIST_DOMAINS_REDIS_KEY,
        JSON.stringify({ ...initialSettings, blocked_signup_tlds: ['ignored-legacy'] })
      );
      const caller = await createCallerForUser(admin.id);
      const result = await caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: await configVersion(),
      });

      const expected = normalizeSignupTlds(blockedSignupTlds ?? envFallbackSignupTlds);
      expect(result.blocked_signup_tlds).toEqual(expected);
      expect(
        JSON.parse(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')
          .blocked_signup_tlds
      ).toEqual(expected);
    }
  );

  it('keeps signup TLDs from the prior completed save when the input field is omitted', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      blocked_tlds: ['asia'],
      expected_version: await configVersion(),
    });
    const loaded = await caller.admin.blacklistDomains.get();
    mockedBackfill.mockClear();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com', 'spam.org'],
      expected_version: loaded.version,
    });

    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });
  });
});

describe('admin.blacklistDomains.get', () => {
  it('returns sorted PG rows and metadata with a canonical SHA256 postgres content token', async () => {
    await setPostgresBlacklist(['spam.org', 'mailinator.com']);
    const settings = {
      ...initialSettings,
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'previous-admin',
      updated_by_email: 'previous-admin@example.com',
    };
    redisValues.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(settings));
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({ ...settings, domains: ['stale-legacy.example'] }, null, 2)
    );
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({
      ...settings,
      domains: ['mailinator.com', 'spam.org'],
      version: contentVersion({ ...settings, domains: ['mailinator.com', 'spam.org'] }),
      dropped_domains: 0,
    });
    expect(config.version).toMatch(/^[0-9a-f]{64}$/);
    expect(mockedRedisGet).toHaveBeenCalledWith(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
  });

  it('falls back to legacy metadata only and ignores its stale or malformed domain field', async () => {
    await setPostgresBlacklist(['stored.example']);
    redisValues.delete(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: { stale: ['legacy.example'] },
        blocked_signup_tlds: [],
        updated_at: 'legacy-time',
        updated_by: 'legacy-admin',
        updated_by_email: 'legacy-admin@example.com',
      })
    );
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.blacklistDomains.get();

    expect(config).toMatchObject({
      domains: ['stored.example'],
      blocked_signup_tlds: [],
      updated_at: 'legacy-time',
      updated_by: 'legacy-admin',
      updated_by_email: 'legacy-admin@example.com',
    });
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
      BLACKLIST_DOMAINS_REDIS_KEY,
    ]);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
  });

  it('uses defaults when both Redis settings keys are missing and saves without changing PG domains', async () => {
    await setPostgresBlacklist(['stored.example']);
    redisValues.delete(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.delete(BLACKLIST_DOMAINS_REDIS_KEY);
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.blacklistDomains.get();

    expect(config).toMatchObject({
      domains: ['stored.example'],
      blocked_signup_tlds: normalizeSignupTlds(envFallbackSignupTlds),
      updated_at: null,
      updated_by: null,
      updated_by_email: null,
    });
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
      BLACKLIST_DOMAINS_REDIS_KEY,
    ]);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();

    const saved = await caller.admin.blacklistDomains.set({
      domains: config.domains,
      expected_version: config.version,
    });

    expect(saved.domains).toEqual(['stored.example']);
    expect(saved.blocked_signup_tlds).toEqual(normalizeSignupTlds(envFallbackSignupTlds));
    expect(JSON.parse(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null')).toEqual({
      domains: [],
      blocked_signup_tlds: normalizeSignupTlds(envFallbackSignupTlds),
      updated_at: saved.updated_at,
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
    });
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'stored.example' }]);
  });

  it('prefers valid small settings without reading malformed legacy JSON', async () => {
    await setPostgresBlacklist(['stored.example']);
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'not-json');
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.blacklistDomains.get();

    expect(config.domains).toEqual(['stored.example']);
    expect(mockedRedisGet.mock.calls.map(([key]) => key)).toEqual([
      BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
    ]);
  });

  it('shows actual stored rows rather than env fallback, including a valid empty table', async () => {
    envFallbackDomains.splice(0, envFallbackDomains.length, 'fallback-only.example');
    await setPostgresBlacklist([]);
    const caller = await createCallerForUser(admin.id);

    expect((await caller.admin.blacklistDomains.get()).domains).toEqual([]);

    await setPostgresBlacklist(['stored.example']);
    expect((await caller.admin.blacklistDomains.get()).domains).toEqual(['stored.example']);
  });

  it.each([undefined, [], [' .ASIA ', 'asia', 'SHOP']])(
    'normalizes only small-settings signup TLDs or their env fallback: %j',
    async blockedSignupTlds => {
      redisValues.set(
        BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
        JSON.stringify({ ...initialSettings, blocked_signup_tlds: blockedSignupTlds })
      );
      const caller = await createCallerForUser(admin.id);

      const config = await caller.admin.blacklistDomains.get();

      expect(config.blocked_signup_tlds).toEqual(
        normalizeSignupTlds(blockedSignupTlds ?? envFallbackSignupTlds)
      );
      expect(config.version).toBe(
        contentVersion({ ...initialSettings, blocked_signup_tlds: blockedSignupTlds })
      );
      expect(config.dropped_domains).toBe(0);
    }
  );

  it.each([undefined, '', 'not-json', '{"domains":["ignored.example"]}'])(
    'gets and saves without reading the absent or malformed legacy blob: %j',
    async legacy => {
      if (legacy !== undefined) redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, legacy);
      await setPostgresBlacklist(['previous.example']);
      const caller = await createCallerForUser(admin.id);
      const loaded = await caller.admin.blacklistDomains.get();
      expect(loaded.domains).toEqual(['previous.example']);

      const result = await caller.admin.blacklistDomains.set({
        domains: [...loaded.domains, 'new.example'],
        expected_version: loaded.version,
      });

      expect(result.domains).toEqual(['previous.example', 'new.example']);
      expect(result.cache_refresh_failed).toBe(false);
      expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['new.example'] });
    }
  );

  it('ignores Redis serialization and unused legacy changes when computing the content hash', async () => {
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'not-json');
    redisValues.set(
      BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(
        {
          updated_by_email: initialSettings.updated_by_email,
          updated_by: initialSettings.updated_by,
          updated_at: initialSettings.updated_at,
          blocked_signup_tlds: initialSettings.blocked_signup_tlds,
          domains: [],
        },
        null,
        2
      )
    );

    expect((await caller.admin.blacklistDomains.get()).version).toBe(loaded.version);
  });

  it.each([
    { blocked_signup_tlds: ['asia'] },
    { updated_at: '2026-11-10T00:00:00.000Z' },
    { updated_by: 'another-admin' },
    { updated_by_email: 'another-admin@example.com' },
  ])('rejects an old editor hash after metadata changes: %j', async changed => {
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    const settings = { ...initialSettings, ...changed };
    redisValues.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(settings));

    const current = await caller.admin.blacklistDomains.get();
    expect(current.version).toBe(contentVersion(settings));
    expect(current.version).not.toBe(loaded.version);
    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['new.example'],
        expected_version: loaded.version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });
    expect(await db.select().from(blacklisted_domains)).toEqual([]);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('holds a SHARE table lock across every bounded domain page and the settings read', async () => {
    const domains = Array.from(
      { length: 2005 },
      (_, i) => `page${String(i).padStart(4, '0')}.example`
    );
    await setPostgresBlacklist(domains);
    const transaction = db.transaction.bind(db);
    const pageLimits: number[] = [];
    const statements: string[] = [];
    const dialect = new PgDialect();
    jest.spyOn(db, 'transaction').mockImplementationOnce(callback =>
      transaction(async tx => {
        const execute = tx.execute.bind(tx);
        jest.spyOn(tx, 'execute').mockImplementation((...args) => {
          const [query] = args;
          const statement =
            typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
          statements.push(statement);
          return execute(...args);
        });
        const select = tx.select.bind(tx);
        jest.spyOn(tx, 'select').mockImplementation((...args) => {
          const builder = select(...args);
          const from = builder.from.bind(builder);
          jest.spyOn(builder, 'from').mockImplementation(table => {
            const query = from(table);
            if (table === blacklisted_domains) {
              const limit = query.limit.bind(query);
              jest.spyOn(query, 'limit').mockImplementation(value => {
                if (typeof value !== 'number') throw new Error('Expected numeric page limit');
                expect(statements).toEqual([
                  expect.stringMatching(/SET LOCAL lock_timeout/i),
                  expect.stringMatching(/SET LOCAL statement_timeout/i),
                  expect.stringMatching(/LOCK TABLE .*blacklisted_domains.* IN SHARE MODE/i),
                ]);
                pageLimits.push(value);
                return limit(value);
              });
            }
            return query;
          });
          return builder;
        });
        return callback(tx);
      })
    );
    mockedRedisGet.mockImplementationOnce(async <T>() => {
      expect(statements).toEqual([
        expect.stringMatching(/SET LOCAL lock_timeout/i),
        expect.stringMatching(/SET LOCAL statement_timeout/i),
        expect.stringMatching(/LOCK TABLE .*blacklisted_domains.* IN SHARE MODE/i),
      ]);
      await expect(
        transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE`);
        })
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
      return JSON.stringify(initialSettings) as T;
    });
    const caller = await createCallerForUser(admin.id);

    const config = await caller.admin.blacklistDomains.get();

    expect(config.domains).toEqual(domains);
    expect(pageLimits).toEqual([1000, 1000, 1000]);
    await transaction(async tx => {
      await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE NOWAIT`);
    });
  });

  it('round-trips more than 200k PG rows and a TLD-only save without losing or backfilling the tail', async () => {
    const domains = Array.from(
      { length: MAX_BLACKLIST_DOMAINS + 5 },
      (_, i) => `bulk${String(i).padStart(6, '0')}.example`
    );
    await setPostgresBlacklist(domains);
    const previous = {
      ...initialSettings,
      blocked_signup_tlds: ['shop'],
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'previous-admin',
      updated_by_email: 'previous-admin@example.com',
    };
    redisValues.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(previous));
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, 'not-json');
    const tail = domains.slice(MAX_BLACKLIST_DOMAINS);
    const user = await insertTestUser({
      google_user_email: `existing@${tail[0]}`,
      email_domain: tail[0],
    });
    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({
      ...previous,
      domains,
      version: await configVersion(),
      dropped_domains: 0,
    });
    const result = await caller.admin.blacklistDomains.set({
      domains: config.domains,
      blocked_tlds: [' .ASIA ', 'asia'],
      expected_version: config.version,
    });

    expect(result.domains).toEqual(domains);
    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(await db.select({ count: count() }).from(blacklisted_domains)).toEqual([
      { count: domains.length },
    ]);
    expect(
      await db
        .select()
        .from(blacklisted_domains)
        .where(inArray(blacklisted_domains.domain, tail))
        .orderBy(blacklisted_domains.domain)
    ).toEqual(tail.map(domain => ({ domain })));
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedRedisEval).toHaveBeenCalledTimes(1);
    const saved = await caller.admin.blacklistDomains.get();
    expect(saved).toEqual({
      domains,
      blocked_signup_tlds: ['asia'],
      updated_at: result.updated_at,
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
      version: await configVersion(),
      dropped_domains: 0,
    });
    expect(saved.version).not.toBe(config.version);
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBeNull();
  }, 60000);
});

describe('admin.blacklistDomains failures', () => {
  it('propagates a missing PG table on get and save without falling back or writing Redis', async () => {
    await setPostgresBlacklist(['previous.example']);
    const expectedVersion = await configVersion();
    const settingsBefore = redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    const caller = await createCallerForUser(admin.id);
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        await tx.execute(
          sql`ALTER TABLE ${blacklisted_domains} RENAME TO temporarily_unavailable_blacklist`
        );
        return callback(tx);
      })
    );

    await expect(caller.admin.blacklistDomains.get()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { cause: { code: '42P01' } },
    });
    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['new.example'],
        expected_version: expectedVersion,
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { cause: { code: '42P01' } },
    });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(settingsBefore);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'not-json',
    'null',
    '{}',
    JSON.stringify({ ...initialSettings, domains: undefined }),
    JSON.stringify({ ...initialSettings, domains: ['must-not-live-in-settings.example'] }),
    JSON.stringify({ ...initialSettings, domains: 'invalid' }),
    JSON.stringify({ ...initialSettings, blocked_signup_tlds: [1] }),
    JSON.stringify({ ...initialSettings, updated_at: 1 }),
    JSON.stringify({ ...initialSettings, updated_by: false }),
    JSON.stringify({ ...initialSettings, updated_by_email: [] }),
  ])('rejects malformed small settings on get and save: %j', async settings => {
    redisValues.set(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY, settings);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({ ...initialSettings, domains: ['legacy-fallback.example'] })
    );
    await setPostgresBlacklist(['previous.example']);
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.blacklistDomains.get()).rejects.toThrow();
    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['new.example'],
        blocked_tlds: ['asia'],
        expected_version: contentVersion({ ...initialSettings, domains: ['previous.example'] }),
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(redisValues.get(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(settings);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(mockedRedisGet).not.toHaveBeenCalledWith(BLACKLIST_DOMAINS_REDIS_KEY);
  });

  it('fails closed on bad legacy metadata without changing PG or running cleanup/backfill', async () => {
    await setPostgresBlacklist(['previous.example']);
    redisValues.delete(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: ['ignored-legacy.example'],
        blocked_signup_tlds: [1],
        updated_at: 'legacy-time',
        updated_by: 'legacy-admin',
        updated_by_email: 'legacy-admin@example.com',
      })
    );
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.blacklistDomains.get()).rejects.toThrow();
    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['new.example'],
        expected_version: contentVersion({ ...initialSettings, domains: ['previous.example'] }),
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(redisValues.has(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY)).toBe(false);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('fails closed on a settings read failure without changing PG or running cleanup/backfill', async () => {
    await setPostgresBlacklist(['previous.example']);
    mockedRedisGet.mockRejectedValue(new Error('settings unavailable'));
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.blacklistDomains.get()).rejects.toThrow();
    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['new.example'],
        expected_version: await configVersion(),
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedRedisEval).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });
});
