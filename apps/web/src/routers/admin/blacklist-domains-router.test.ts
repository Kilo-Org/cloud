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
    set: jest.fn(),
    del: jest.fn(),
  },
}));

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import type * as Sentry from '@sentry/nextjs';
import { captureException } from '@sentry/nextjs';
import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { blacklisted_domains, kilocode_users } from '@kilocode/db';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { count, eq, inArray, sql } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { computeBlacklistStats } from '@/lib/abuse/blacklist-domain-stats';
import { isDomainOnBlacklist } from './blacklist-domains-router';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';
import type { BlockBlacklistedDomainsBackfillResponse } from '@/lib/abuse/block-blacklisted-domains';
import {
  BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import {
  clearEmailBlacklistCache,
  isEmailBlacklisted,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import type { User } from '@kilocode/db/schema';
import { setAdminActionSinkForTest, type AdminActionEvent } from '@/lib/admin/admin-action-audit';

type BackfillBatch = (params: {
  actorId: string;
  domains: string[];
}) => Promise<BlockBlacklistedDomainsBackfillResponse>;

const actualBackfillModule = jest.requireActual<{
  backfillBlockBlacklistedDomainsBatch: BackfillBatch;
}>('@/lib/abuse/block-blacklisted-domains');
const mockedBackfill = jest.mocked(backfillBlockBlacklistedDomainsBatch);
const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedRedisDel = jest.mocked(redisClient.del);
const mockedCaptureException = jest.mocked(captureException);
const redisValues = new Map<string, string>();

const saveFailureMessage =
  'Blacklist save failed. Reload the list before retrying; the signup TLDs may have been saved.';
const conflictMessage = 'Blacklist changed. Reload the complete list before saving.';
const unusedVersion = '0'.repeat(64);

type StoredSettings = {
  blocked_signup_tlds?: string[];
  updated_at: string | null;
  updated_by: string | null;
  updated_by_email: string | null;
};

const previousSettings: StoredSettings = {
  blocked_signup_tlds: ['asia'],
  updated_at: '2026-01-01T00:00:00.000Z',
  updated_by: 'previous-admin',
  updated_by_email: 'previous-admin@example.com',
};

function storeSettings(settings: StoredSettings): string {
  const raw = JSON.stringify(settings);
  redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, raw);
  return raw;
}

function storeLegacyBlob(raw: string): void {
  redisValues.set(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY, raw);
  redisValues.set(LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY, '1767225600000');
}

function storedSettings(): unknown {
  return JSON.parse(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY) ?? 'null');
}

async function insertBlacklistedDomains(domains: string[]): Promise<void> {
  await db.insert(blacklisted_domains).values(domains.map(domain => ({ domain })));
}

async function tableDomains(): Promise<string[]> {
  const rows = await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain);
  return rows.map(row => row.domain);
}

// Polls pg_locks until one transaction holds the blacklist lock and another waits for it.
async function waitForBlockedLock(waitingMode: 'ShareLock' | 'ExclusiveLock'): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await db.execute<{ mode: string; granted: boolean }>(sql`
      SELECT mode, granted FROM pg_locks
      WHERE relation = 'public.blacklisted_domains'::regclass
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `);
    const held = rows.some(row => row.mode === 'ExclusiveLock' && row.granted);
    const waiting = rows.some(row => row.mode === waitingMode && !row.granted);
    if (held && waiting) return true;
  }
  return false;
}

let admin: User;
let auditEvents: AdminActionEvent[];

beforeEach(async () => {
  await cleanupDbForTest();
  auditEvents = [];
  setAdminActionSinkForTest(event => auditEvents.push(event));
  clearEmailBlacklistCache();
  redisValues.clear();
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
  mockedRedisDel.mockReset();
  mockedRedisDel.mockImplementation(async (...keys: string[]) => {
    return keys.filter(key => redisValues.delete(key)).length;
  });
  mockedCaptureException.mockReset();
  mockedBackfill.mockReset();
  mockedBackfill.mockImplementation(actualBackfillModule.backfillBlockBlacklistedDomainsBatch);
  admin = await insertTestUser({
    google_user_email: `admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
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
    // 'notmailinator.com' should not match 'mailinator.com' just because the
    // latter is a suffix of the former as a raw string.
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
  it('returns an empty breakdown for an empty blacklist', async () => {
    await insertTestUser({
      google_user_email: 'a@example.com',
      email_domain: 'example.com',
    });

    const caller = await createCallerForUser(admin.id);
    const stats = await caller.admin.blacklistDomains.stats();

    expect(stats).toEqual({ domains: [], totalDomains: 0, totalBlockedUsers: 0 });
  });

  it('counts users for each stored domain, including subdomains', async () => {
    await insertBlacklistedDomains(['mailinator.com', 'spam.org', 'unused.io']);
    await insertTestUser({ google_user_email: 'a@mailinator.com' });
    await insertTestUser({ google_user_email: 'b@sub.mailinator.com' });
    await insertTestUser({ google_user_email: 'c@spam.org' });
    await insertTestUser({ google_user_email: 'd@notmailinator.com' });

    const caller = await createCallerForUser(admin.id);
    const stats = await caller.admin.blacklistDomains.stats();

    expect(stats).toEqual({
      domains: [
        { domain: 'mailinator.com', blockedCount: 2 },
        { domain: 'spam.org', blockedCount: 1 },
        { domain: 'unused.io', blockedCount: 0 },
      ],
      totalDomains: 3,
      totalBlockedUsers: 3,
    });
  });
});

describe('admin.blacklistDomains.suspicious', () => {
  it('aggregates user counts by email_domain and returns blocked counts and percent', async () => {
    await insertTestUser({
      google_user_email: 'a@example.com',
      email_domain: 'example.com',
    });
    await insertTestUser({
      google_user_email: 'b@example.com',
      email_domain: 'example.com',
    });
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
    // more-blocked.com: 2 of 4 blocked (50%)
    for (let i = 0; i < 2; i++) {
      await insertTestUser({
        google_user_email: `u${i}@more-blocked.com`,
        email_domain: 'more-blocked.com',
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertTestUser({
        google_user_email: `b${i}@more-blocked.com`,
        email_domain: 'more-blocked.com',
        blocked_reason: 'abuse',
      });
    }
    // fewer-blocked.com: 1 of 2 blocked (50%)
    await insertTestUser({
      google_user_email: 'u@fewer-blocked.com',
      email_domain: 'fewer-blocked.com',
    });
    await insertTestUser({
      google_user_email: 'b@fewer-blocked.com',
      email_domain: 'fewer-blocked.com',
      blocked_reason: 'abuse',
    });

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const ordered = domains.map(d => d.domain);
    expect(ordered.indexOf('more-blocked.com')).toBeLessThan(ordered.indexOf('fewer-blocked.com'));
  });

  it('hides domains with fewer than 30% of accounts blocked', async () => {
    // noisy.com: 10 clean users + 0 blocked → 0% → filtered out
    for (let i = 0; i < 10; i++) {
      await insertTestUser({
        google_user_email: `u${i}@noisy.com`,
        email_domain: 'noisy.com',
      });
    }
    // under-threshold.com: 8 clean + 2 blocked → 20% → filtered out (below 30%)
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
    // over-threshold.com: 7 clean + 3 blocked → 30% → surfaced
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

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const names = domains.map(d => d.domain);
    expect(names).toContain('over-threshold.com');
    expect(names).not.toContain('noisy.com');
    expect(names).not.toContain('under-threshold.com');
  });

  it('includes domains below the blocked-percent threshold when provider filtering is disabled', async () => {
    for (let i = 0; i < 9; i++) {
      await insertTestUser({
        google_user_email: `u${i}@hotmail.com`,
        email_domain: 'hotmail.com',
      });
    }
    await insertTestUser({
      google_user_email: 'blocked@hotmail.com',
      email_domain: 'hotmail.com',
      blocked_reason: 'abuse',
    });

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious({
      hideLegitimateProviders: false,
    });

    expect(domains.map(d => d.domain)).toContain('hotmail.com');
  });

  it('excludes users whose email_domain is NULL', async () => {
    await insertTestUser({
      google_user_email: 'a@example.com',
      email_domain: null,
    });

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

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const example = domains.find(d => d.domain === 'example.com');
    expect(example).toBeDefined();
    expect(typeof example!.firstSeen).toBe('string');
    expect(typeof example!.lastSeen).toBe('string');
  });

  it('flags domains covered by a stored blacklist entry', async () => {
    await insertBlacklistedDomains(['spam.org']);
    await insertTestUser({
      google_user_email: 'x@spam.org',
      email_domain: 'spam.org',
      blocked_reason: 'abuse',
    });
    await insertTestUser({
      google_user_email: 'y@mail.spam.org',
      email_domain: 'mail.spam.org',
      blocked_reason: 'abuse',
    });
    await insertTestUser({
      google_user_email: 'z@notspam.org',
      email_domain: 'notspam.org',
      blocked_reason: 'abuse',
    });

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    expect(Object.fromEntries(domains.map(d => [d.domain, d.isBlacklisted]))).toEqual({
      'spam.org': true,
      'mail.spam.org': true,
      'notspam.org': false,
    });
  });
});

describe('admin.blacklistDomains.set', () => {
  it('blocks existing accounts on a newly added domain', async () => {
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
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(result).toEqual({
      domains: ['mailinator.com'],
      blocked_signup_tlds: ['shop', 'top'],
      updated_at: expect.any(String),
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
      backfill: { blocked: 1, remaining: false, failed: false },
    });
    expect(await tableDomains()).toEqual(['mailinator.com']);

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

  it('writes only the settings to Redis, never the domain list', async () => {
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com', 'spam.org'],
      blocked_tlds: ['asia'],
      expected_version: version,
    });

    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify({
        blocked_signup_tlds: ['asia'],
        updated_at: result.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      })
    );
    expect(storedSettings()).not.toHaveProperty('domains');
    expect([...redisValues.keys()]).toEqual([BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY]);
  });

  it('deletes both legacy keys with one DEL after the save commits', async () => {
    storeSettings(previousSettings);
    storeLegacyBlob(JSON.stringify(previousSettings));
    let committedDomains: string[] | undefined;
    mockedRedisDel.mockImplementationOnce(async (...keys: string[]) => {
      committedDomains = await tableDomains();
      return keys.filter(key => redisValues.delete(key)).length;
    });
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();

    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(mockedRedisDel).toHaveBeenCalledTimes(1);
    expect(mockedRedisDel).toHaveBeenCalledWith(
      LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
      LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY
    );
    expect(committedDomains).toEqual(['mailinator.com']);
    expect([...redisValues.keys()]).toEqual([BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY]);
  });

  it('migrates the legacy settings within a first-ever save before deleting the legacy keys', async () => {
    const legacyRaw = JSON.stringify({ ...previousSettings, domains: ['legacy-only.example'] });
    storeLegacyBlob(legacyRaw);
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    redisValues.delete(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY);
    mockedRedisSet.mockClear();

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(storedSettings()).toEqual({
      blocked_signup_tlds: ['asia'],
      updated_at: result.updated_at,
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
    });
    expect(mockedRedisSet).toHaveBeenNthCalledWith(
      1,
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(previousSettings),
      { nx: true }
    );
    expect(mockedRedisDel).toHaveBeenCalledTimes(1);
    expect(mockedRedisDel.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...mockedRedisSet.mock.invocationCallOrder)
    );
    expect(redisValues.has(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY)).toBe(false);
    expect(redisValues.has(LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(false);
  });

  it('returns success and still backfills when deleting the legacy keys fails', async () => {
    const target = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const deleteError = new Error('redis delete failed');
    mockedRedisDel.mockRejectedValue(deleteError);
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(await tableDomains()).toEqual(['mailinator.com']);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    expect(mockedCaptureException).toHaveBeenCalledWith(deleteError, {
      tags: { source: 'blacklist_domains_legacy_cleanup' },
    });
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, target.id));
    expect(row.blocked_reason).toBe('domainblocked');
  });

  it('applies the saved list to access checks immediately', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(isEmailBlacklisted('user@mailinator.com')).resolves.toBe(false);

    const { version } = await caller.admin.blacklistDomains.get();
    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    await expect(isEmailBlacklisted('user@mailinator.com')).resolves.toBe(true);
  });

  it('replaces the full normalized list but only backfills newly added domains', async () => {
    await insertBlacklistedDomains(['mailinator.com', 'removed.example']);
    const existing = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: [' MAILINATOR.COM ', 'Spam.ORG', 'spam.org', '   '],
      expected_version: version,
    });

    expect(result.domains).toEqual(['mailinator.com', 'spam.org']);
    expect(await tableDomains()).toEqual(['mailinator.com', 'spam.org']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });

    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, existing.id));
    expect(row.blocked_reason).toBeNull();
  });

  it.each([{ domains: ['mailinator.com'] }, { domains: [] }])(
    'removes domains without backfilling: $domains',
    async ({ domains: remainingDomains }) => {
      storeSettings(previousSettings);
      await insertBlacklistedDomains(['mailinator.com', 'removed.example']);
      const caller = await createCallerForUser(admin.id);
      const { version } = await caller.admin.blacklistDomains.get();

      const result = await caller.admin.blacklistDomains.set({
        domains: remainingDomains,
        expected_version: version,
      });

      expect(result.domains).toEqual(remainingDomains);
      expect(await tableDomains()).toEqual(remainingDomains);
      expect(storedSettings()).toEqual({
        blocked_signup_tlds: ['asia'],
        updated_at: result.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      });
      expect(mockedBackfill).not.toHaveBeenCalled();
    }
  );

  it('commits the list before starting the existing-account backfill', async () => {
    let committedDomains: { domain: string }[] | undefined;
    mockedBackfill.mockImplementationOnce(async () => {
      committedDomains = await db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE NOWAIT`);
        return tx.select().from(blacklisted_domains);
      });
      return { processed: 0, remaining: false };
    });
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(committedDomains).toEqual([{ domain: 'mailinator.com' }]);
  });

  it('keeps the saved list when the automatic block fails', async () => {
    mockedBackfill.mockRejectedValue(new Error('database unavailable'));

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: true });
    expect(storedSettings()).toMatchObject({ updated_by: admin.id });
    expect(await tableDomains()).toEqual(['mailinator.com']);
  });

  it('fails without changes when the stored settings cannot be read', async () => {
    await insertBlacklistedDomains(['previous.example']);
    mockedRedisGet.mockRejectedValue(new Error('redis unavailable'));

    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: unusedVersion,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: saveFailureMessage });

    expect(await tableDomains()).toEqual(['previous.example']);
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
    expect(mockedRedisDel).not.toHaveBeenCalled();
  });

  it('rejects a stale version after a direct table edit without changing anything', async () => {
    const previousRaw = storeSettings(previousSettings);
    storeLegacyBlob(previousRaw);
    await insertBlacklistedDomains(['first.example', 'second.example']);
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    await insertBlacklistedDomains(['third.example']);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: loaded.domains,
        blocked_tlds: ['shop'],
        expected_version: loaded.version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(await tableDomains()).toEqual(['first.example', 'second.example', 'third.example']);
    expect(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY)).toBe(previousRaw);
    expect(mockedRedisSet).not.toHaveBeenCalled();
    expect(mockedRedisDel).not.toHaveBeenCalled();
    expect(redisValues.get(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY)).toBe(previousRaw);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('rejects a stale version after the settings changed without changing anything', async () => {
    storeSettings(previousSettings);
    await insertBlacklistedDomains(['first.example']);
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    const currentRaw = storeSettings({ ...previousSettings, blocked_signup_tlds: ['top'] });

    await expect(
      caller.admin.blacklistDomains.set({
        domains: [...loaded.domains, 'second.example'],
        expected_version: loaded.version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(await tableDomains()).toEqual(['first.example']);
    expect(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY)).toBe(currentRaw);
    expect(mockedRedisSet).not.toHaveBeenCalled();
    expect(mockedRedisDel).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('rolls back the table and skips backfill when the settings write fails', async () => {
    const previousRaw = storeSettings(previousSettings);
    storeLegacyBlob(previousRaw);
    await insertBlacklistedDomains(['previous.example']);
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    mockedRedisSet.mockRejectedValue(new Error('redis write failed'));

    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: version,
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: saveFailureMessage,
      cause: { message: 'redis write failed' },
    });

    expect(await tableDomains()).toEqual(['previous.example']);
    expect(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY)).toBe(previousRaw);
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
    expect(mockedRedisDel).not.toHaveBeenCalled();
    expect(redisValues.get(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY)).toBe(previousRaw);
    expect(mockedBackfill).not.toHaveBeenCalled();
    await expect(caller.admin.blacklistDomains.get()).resolves.toMatchObject({ version });
  });

  it('leaves the table and settings intact on a second-batch failure and backfills new domains on retry', async () => {
    await insertBlacklistedDomains(['previous.example']);
    const previousRaw = storeSettings(previousSettings);
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
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const input = { domains, expected_version: version };
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
        message: saveFailureMessage,
        cause: { cause: { message: 'forced second blacklist batch failure' } },
      });

      expect(await tableDomains()).toEqual(['previous.example']);
      expect(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY)).toBe(previousRaw);
      expect(mockedRedisSet).not.toHaveBeenCalled();
      expect(mockedRedisDel).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`
        DROP TRIGGER fail_blacklist_second_batch ON public.blacklisted_domains;
        DROP FUNCTION public.fail_blacklist_second_batch();
      `);
    }
    const result = await caller.admin.blacklistDomains.set(input);

    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
    expect(mockedRedisDel).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
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

  it('serializes saves before reading the current list and rejects the stale concurrent version', async () => {
    storeSettings({ ...previousSettings, blocked_signup_tlds: ['shop'] });
    const writingFirst = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    mockedRedisSet.mockImplementationOnce(async (key: string, value: unknown) => {
      writingFirst.resolve();
      await releaseFirst.promise;
      redisValues.set(key, String(value));
      return 'OK';
    });
    mockedBackfill.mockResolvedValue({ processed: 0, remaining: false });
    const caller = await createCallerForUser(admin.id);
    const { version: expectedVersion } = await caller.admin.blacklistDomains.get();
    mockedRedisGet.mockClear();
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

      expect(await waitForBlockedLock('ExclusiveLock')).toBe(true);
      expect(mockedRedisGet).toHaveBeenCalledTimes(1);
      expect(mockedRedisSet).toHaveBeenCalledTimes(1);
      expect(await tableDomains()).toEqual([]);
      releaseFirst.resolve();
      const firstResult = await first;
      await secondFailure;

      expect(firstResult.blocked_signup_tlds).toEqual(['asia']);
      expect(mockedRedisGet).toHaveBeenCalledTimes(2);
      expect(mockedRedisSet).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledWith({
        actorId: admin.id,
        domains: ['first.example'],
      });
      expect(await tableDomains()).toEqual(['first.example']);
      expect(storedSettings()).toEqual({
        blocked_signup_tlds: ['asia'],
        updated_at: firstResult.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      });
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled(saves);
    }
  }, 15000);

  it('stores normalized signup TLDs and never backfills on a TLD change', async () => {
    const onDomain = await insertTestUser({
      google_user_email: 'a@example.asia',
      email_domain: 'example.asia',
    });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: [],
      blocked_tlds: ['  .ASIA  ', 'shop', 'asia'],
      expected_version: version,
    });

    expect(result.blocked_signup_tlds).toEqual(['asia', 'shop']);
    expect(storedSettings()).toMatchObject({ blocked_signup_tlds: ['asia', 'shop'] });

    // A TLD gates new signups only, so existing accounts stay untouched.
    expect(mockedBackfill).not.toHaveBeenCalled();
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, onDomain.id));
    expect(row.blocked_reason).toBeNull();
  });

  it('keeps signup TLDs from the prior save when the field is omitted', async () => {
    const caller = await createCallerForUser(admin.id);
    const initial = await caller.admin.blacklistDomains.get();
    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      blocked_tlds: ['asia'],
      expected_version: initial.version,
    });
    const loaded = await caller.admin.blacklistDomains.get();
    mockedBackfill.mockClear();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com', 'spam.org'],
      expected_version: loaded.version,
    });

    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(storedSettings()).toMatchObject({ blocked_signup_tlds: ['asia'] });
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });
  });

  it('stores the effective TLD fallback when no list is stored yet', async () => {
    storeSettings({ updated_at: null, updated_by: null, updated_by_email: null });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: version,
    });

    // The settings are written with the effective list auth enforces, not an
    // empty field that would silently re-allow every TLD.
    expect(result.blocked_signup_tlds).toEqual(['shop', 'top']);
    expect(storedSettings()).toMatchObject({ blocked_signup_tlds: ['shop', 'top'] });
  });
});

describe('admin.blacklistDomains.get', () => {
  it('shows defaults and the effective TLD list when nothing is stored yet', async () => {
    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({
      domains: [],
      blocked_signup_tlds: ['shop', 'top'],
      updated_at: null,
      updated_by: null,
      updated_by_email: null,
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('returns the Postgres domains with the stored settings', async () => {
    storeSettings(previousSettings);
    await insertBlacklistedDomains(['spam.org', 'mailinator.com']);

    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({
      ...previousSettings,
      domains: ['mailinator.com', 'spam.org'],
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('keeps the version stable until the table or the settings change', async () => {
    storeSettings(previousSettings);
    await insertBlacklistedDomains(['mailinator.com']);
    const caller = await createCallerForUser(admin.id);

    const first = await caller.admin.blacklistDomains.get();
    const unchanged = await caller.admin.blacklistDomains.get();
    await insertBlacklistedDomains(['spam.org']);
    const afterTableEdit = await caller.admin.blacklistDomains.get();
    storeSettings({ ...previousSettings, blocked_signup_tlds: ['top'] });
    const afterSettingsEdit = await caller.admin.blacklistDomains.get();

    expect(unchanged.version).toBe(first.version);
    expect(afterTableEdit.domains).toEqual(['mailinator.com', 'spam.org']);
    expect(afterTableEdit.version).not.toBe(first.version);
    expect(afterSettingsEdit.version).not.toBe(afterTableEdit.version);
  });

  it('migrates legacy settings once and ignores the legacy domain list', async () => {
    await insertBlacklistedDomains(['postgres.example']);
    const legacyRaw = JSON.stringify({ ...previousSettings, domains: ['legacy-only.example'] });
    redisValues.set(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY, legacyRaw);

    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({
      ...previousSettings,
      domains: ['postgres.example'],
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(previousSettings),
      { nx: true }
    );
    expect(storedSettings()).toEqual(previousSettings);
    expect(redisValues.get(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY)).toBe(legacyRaw);

    const again = await caller.admin.blacklistDomains.get();
    expect(again.version).toBe(config.version);
    expect(mockedRedisSet).toHaveBeenCalledTimes(1);

    const result = await caller.admin.blacklistDomains.set({
      domains: config.domains,
      expected_version: config.version,
    });
    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(await tableDomains()).toEqual(['postgres.example']);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('waits for an in-flight save and returns its committed list and settings', async () => {
    const writingSave = Promise.withResolvers<void>();
    const releaseSave = Promise.withResolvers<void>();
    mockedRedisSet.mockImplementationOnce(async (key: string, value: unknown) => {
      writingSave.resolve();
      await releaseSave.promise;
      redisValues.set(key, String(value));
      return 'OK';
    });
    mockedBackfill.mockResolvedValue({ processed: 0, remaining: false });
    const caller = await createCallerForUser(admin.id);
    const initial = await caller.admin.blacklistDomains.get();
    const save = caller.admin.blacklistDomains.set({
      domains: ['saved.example'],
      blocked_tlds: ['asia'],
      expected_version: initial.version,
    });
    const pending: Promise<unknown>[] = [save];
    try {
      await writingSave.promise;
      const read = caller.admin.blacklistDomains.get();
      pending.push(read);

      expect(await waitForBlockedLock('ShareLock')).toBe(true);
      releaseSave.resolve();
      await save;
      const loaded = await read;

      expect(loaded).toMatchObject({
        domains: ['saved.example'],
        blocked_signup_tlds: ['asia'],
        updated_by: admin.id,
      });
      expect(loaded.version).toBe((await caller.admin.blacklistDomains.get()).version);
    } finally {
      releaseSave.resolve();
      await Promise.allSettled(pending);
    }
  }, 15000);

  it.each(['', 'not-json'])(
    'rejects malformed stored settings %j on get and save without writes',
    async raw => {
      redisValues.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, raw);
      await insertBlacklistedDomains(['previous.example']);
      const caller = await createCallerForUser(admin.id);

      await expect(caller.admin.blacklistDomains.get()).rejects.toThrow();
      await expect(
        caller.admin.blacklistDomains.set({
          domains: ['mailinator.com'],
          expected_version: unusedVersion,
        })
      ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: saveFailureMessage });

      expect(await tableDomains()).toEqual(['previous.example']);
      expect(redisValues.get(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY)).toBe(raw);
      expect(mockedRedisSet).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
    }
  );
});

describe('admin.blacklistDomains.removeDomainPreview', () => {
  it('splits matching domain-blocked accounts by positive balance', async () => {
    await insertBlacklistedDomains(['mailinator.com']);
    await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
      microdollars_used: 40,
    });
    await insertTestUser({
      google_user_email: 'b@evil.mailinator.com',
      email_domain: 'evil.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
      microdollars_used: 100,
    });
    await insertTestUser({
      google_user_email: 'c@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'manual',
      total_microdollars_acquired: 100,
    });

    const caller = await createCallerForUser(admin.id);
    const preview = await caller.admin.blacklistDomains.removeDomainPreview({
      domain: ' MAILINATOR.COM ',
    });

    expect(preview).toEqual({
      domain: 'mailinator.com',
      onBlacklist: true,
      stillBlacklistedBy: null,
      unblockable: 1,
      keptBlocked: 1,
    });
  });

  it('reports the remaining entry that still covers the domain', async () => {
    await insertBlacklistedDomains(['mailinator.com', 'sub.mailinator.com']);
    await insertTestUser({
      google_user_email: 'a@sub.mailinator.com',
      email_domain: 'sub.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    const caller = await createCallerForUser(admin.id);
    const preview = await caller.admin.blacklistDomains.removeDomainPreview({
      domain: 'sub.mailinator.com',
    });

    expect(preview).toEqual({
      domain: 'sub.mailinator.com',
      onBlacklist: true,
      stillBlacklistedBy: 'mailinator.com',
      unblockable: 0,
      keptBlocked: 0,
    });
  });
});

describe('admin.blacklistDomains.removeDomain', () => {
  it('removes the domain without unblocking by default', async () => {
    await insertBlacklistedDomains(['mailinator.com']);
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
      api_token_pepper: 'rotated-pepper',
    });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.removeDomain({
      domain: ' MAILINATOR.COM ',
      expected_version: version,
    });

    expect(result).toEqual({
      domains: [],
      blocked_signup_tlds: ['shop', 'top'],
      updated_at: expect.any(String),
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
      removed: true,
      unblock: {
        requested: false,
        unblocked: 0,
        keptBlocked: 0,
        remaining: false,
        failed: false,
      },
    });
    expect(await tableDomains()).toEqual([]);
    const [row] = await db
      .select({
        blocked_reason: kilocode_users.blocked_reason,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row).toEqual({
      blocked_reason: 'domainblocked',
      api_token_pepper: 'rotated-pepper',
    });
    expect(auditEvents.map(event => event.action)).toEqual(['blacklist.domain.remove']);
    expect(auditEvents[0].metadata).toEqual({ domain: 'mailinator.com', removed: true });
  });

  it('removes the domain and unblocks only positive-balance domain blocks', async () => {
    await insertBlacklistedDomains(['mailinator.com']);
    const target = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      blocked_at: '2026-01-01T00:00:00.000Z',
      blocked_by_kilo_user_id: 'blocking-admin',
      api_token_pepper: 'rotated-pepper',
      total_microdollars_acquired: 100,
      microdollars_used: 40,
    });
    const subdomain = await insertTestUser({
      google_user_email: 'b@evil.mailinator.com',
      email_domain: 'evil.mailinator.com',
      blocked_reason: 'domainblocked',
      api_token_pepper: 'subdomain-pepper',
      total_microdollars_acquired: 50,
    });
    const zeroBalance = await insertTestUser({
      google_user_email: 'c@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
      microdollars_used: 100,
    });
    const negativeBalance = await insertTestUser({
      google_user_email: 'd@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 50,
      microdollars_used: 150,
    });
    const manual = await insertTestUser({
      google_user_email: 'e@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'manual',
      total_microdollars_acquired: 100,
    });
    const adminAccount = await insertTestUser({
      google_user_email: 'f@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      is_admin: true,
      total_microdollars_acquired: 100,
    });

    await expect(isEmailBlacklisted('someone@mailinator.com')).resolves.toBe(true);

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.removeDomain({
      domain: ' MAILINATOR.COM ',
      expected_version: version,
      unblockUsers: true,
    });

    expect(result.domains).toEqual([]);
    expect(result.removed).toBe(true);
    expect(result.unblock).toEqual({
      requested: true,
      unblocked: 2,
      keptBlocked: 2,
      remaining: false,
      failed: false,
    });
    await expect(isEmailBlacklisted('someone@mailinator.com')).resolves.toBe(false);

    const rows = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_at: kilocode_users.blocked_at,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(
        inArray(kilocode_users.id, [
          target.id,
          subdomain.id,
          zeroBalance.id,
          negativeBalance.id,
          manual.id,
          adminAccount.id,
        ])
      );
    const byId = new Map(rows.map(row => [row.id, row]));

    expect(byId.get(target.id)).toMatchObject({
      blocked_reason: null,
      blocked_at: null,
      blocked_by_kilo_user_id: null,
      api_token_pepper: 'rotated-pepper',
    });
    expect(byId.get(subdomain.id)).toMatchObject({
      blocked_reason: null,
      api_token_pepper: 'subdomain-pepper',
    });
    expect(byId.get(zeroBalance.id)?.blocked_reason).toBe('domainblocked');
    expect(byId.get(negativeBalance.id)?.blocked_reason).toBe('domainblocked');
    expect(byId.get(manual.id)?.blocked_reason).toBe('manual');
    expect(byId.get(adminAccount.id)?.blocked_reason).toBe('domainblocked');

    expect(auditEvents.map(event => event.action)).toEqual([
      'blacklist.domain.remove',
      'blacklist.domain.unblock',
    ]);
    expect(auditEvents[1].metadata).toEqual({
      domain: 'mailinator.com',
      unblocked: 2,
      keptBlocked: 2,
      remaining: false,
      failed: false,
    });
  });

  it('allows removal while a parent entry remains and leaves blocks in place', async () => {
    await insertBlacklistedDomains(['mailinator.com', 'sub.mailinator.com']);
    const user = await insertTestUser({
      google_user_email: 'a@sub.mailinator.com',
      email_domain: 'sub.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    const result = await caller.admin.blacklistDomains.removeDomain({
      domain: 'sub.mailinator.com',
      expected_version: version,
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.removed).toBe(true);
    expect(result.unblock.unblocked).toBe(0);
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBe('domainblocked');
    expect(auditEvents.map(event => event.action)).toEqual(['blacklist.domain.remove']);
  });

  it('refuses to unblock while a remaining entry still covers the domain', async () => {
    await insertBlacklistedDomains(['mailinator.com', 'sub.mailinator.com']);
    const user = await insertTestUser({
      google_user_email: 'a@sub.mailinator.com',
      email_domain: 'sub.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();

    await expect(
      caller.admin.blacklistDomains.removeDomain({
        domain: 'sub.mailinator.com',
        expected_version: version,
        unblockUsers: true,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message:
        'sub.mailinator.com is still covered by the "mailinator.com" entry. Remove that entry first.',
    });

    expect(await tableDomains()).toEqual(['mailinator.com', 'sub.mailinator.com']);
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBe('domainblocked');
    expect(auditEvents).toEqual([]);
  });

  it('rejects a stale version without removing or unblocking', async () => {
    await insertBlacklistedDomains(['mailinator.com']);
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    await insertBlacklistedDomains(['spam.org']);

    await expect(
      caller.admin.blacklistDomains.removeDomain({
        domain: 'mailinator.com',
        expected_version: loaded.version,
        unblockUsers: true,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(await tableDomains()).toEqual(['mailinator.com', 'spam.org']);
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBe('domainblocked');
    expect(auditEvents).toEqual([]);
  });

  it('unblocks an already removed domain without rewriting the list', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    mockedRedisSet.mockClear();

    const result = await caller.admin.blacklistDomains.removeDomain({
      domain: 'mailinator.com',
      expected_version: version,
      unblockUsers: true,
    });

    expect(result.removed).toBe(false);
    expect(result.unblock).toEqual({
      requested: true,
      unblocked: 1,
      keptBlocked: 0,
      remaining: false,
      failed: false,
    });
    expect(mockedRedisSet).not.toHaveBeenCalled();
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBeNull();
    expect(auditEvents.map(event => event.action)).toEqual(['blacklist.domain.unblock']);
  });

  it('leaves the list removed and reports failure when unblocking fails', async () => {
    await insertBlacklistedDomains(['mailinator.com']);
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });
    const caller = await createCallerForUser(admin.id);
    const { version } = await caller.admin.blacklistDomains.get();
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION public.fail_unblock() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced unblock failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_unblock
        BEFORE UPDATE OF blocked_reason ON public.kilocode_users
        FOR EACH STATEMENT EXECUTE FUNCTION public.fail_unblock();
    `);
    try {
      const result = await caller.admin.blacklistDomains.removeDomain({
        domain: 'mailinator.com',
        expected_version: version,
        unblockUsers: true,
      });

      expect(result.domains).toEqual([]);
      expect(result.removed).toBe(true);
      expect(result.unblock).toEqual({
        requested: true,
        unblocked: 0,
        keptBlocked: 0,
        remaining: false,
        failed: true,
      });
      expect(auditEvents.map(event => event.action)).toEqual([
        'blacklist.domain.remove',
        'blacklist.domain.unblock',
      ]);
      expect(auditEvents[1].metadata).toEqual(
        expect.objectContaining({ domain: 'mailinator.com', failed: true })
      );
    } finally {
      await db.execute(sql`
        DROP TRIGGER fail_unblock ON public.kilocode_users;
        DROP FUNCTION public.fail_unblock();
      `);
    }

    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBe('domainblocked');
    expect(await tableDomains()).toEqual([]);
  });
});
