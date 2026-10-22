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
  },
}));

import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { eq, inArray } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { computeBlacklistStats, isDomainOnBlacklist } from './blacklist-domains-router';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';
import type { BlockBlacklistedDomainsBackfillResponse } from '@/lib/abuse/block-blacklisted-domains';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import type { User } from '@kilocode/db/schema';

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

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  mockedRedisGet.mockReset();
  mockedRedisGet.mockResolvedValue(null);
  mockedRedisSet.mockReset();
  mockedRedisSet.mockResolvedValue('OK');
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
  it('sums per-email_domain counts for each blacklist entry by exact match', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com', 'spam.org'],
      [
        { email_domain: 'mailinator.com', count: 12 },
        { email_domain: 'spam.org', count: 5 },
        { email_domain: 'legit.com', count: 99 },
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
        { email_domain: 'mailinator.com', count: 4 },
        { email_domain: 'evil.mailinator.com', count: 3 },
        { email_domain: 'a.b.mailinator.com', count: 2 },
        { email_domain: 'notmailinator.com', count: 100 },
      ]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 9 }]);
    expect(stats.totalBlockedUsers).toBe(9);
  });

  it('orders result by blockedCount descending', () => {
    const stats = computeBlacklistStats(
      ['first.com', 'second.com', 'third.com'],
      [
        { email_domain: 'first.com', count: 1 },
        { email_domain: 'second.com', count: 10 },
        { email_domain: 'third.com', count: 5 },
      ]
    );

    expect(stats.domains.map(d => d.domain)).toEqual(['second.com', 'third.com', 'first.com']);
  });

  it('caps the returned rows while keeping the full domain total', () => {
    const stats = computeBlacklistStats(
      ['first.com', 'second.com', 'third.com'],
      [
        { email_domain: 'first.com', count: 1 },
        { email_domain: 'second.com', count: 10 },
        { email_domain: 'third.com', count: 5 },
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

  it('ignores rows with null email_domain', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com'],
      [
        { email_domain: null, count: 999 },
        { email_domain: 'mailinator.com', count: 3 },
      ]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 3 }]);
  });

  it('returns zero-count entries for blacklist entries with no matching users', () => {
    const stats = computeBlacklistStats(['unused.com'], [{ email_domain: 'other.com', count: 10 }]);

    expect(stats.domains).toEqual([{ domain: 'unused.com', blockedCount: 0 }]);
    expect(stats.totalBlockedUsers).toBe(0);
  });

  it('counts one group once for each matching entry, including nested entries', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com', 'sub.mailinator.com'],
      [{ email_domain: 'sub.mailinator.com', count: 3 }]
    );

    expect(stats.domains).toEqual([
      { domain: 'mailinator.com', blockedCount: 3 },
      { domain: 'sub.mailinator.com', blockedCount: 3 },
    ]);
    expect(stats.totalBlockedUsers).toBe(6);
  });

  it('does not match a group whose label boundary differs from the entry', () => {
    const stats = computeBlacklistStats(
      ['mailinator.com'],
      [{ email_domain: 'notmailinator.com', count: 50 }]
    );

    expect(stats.domains).toEqual([{ domain: 'mailinator.com', blockedCount: 0 }]);
  });

  it('returns empty stats for an empty blacklist', () => {
    const stats = computeBlacklistStats([], [{ email_domain: 'anything.com', count: 5 }]);

    expect(stats.domains).toEqual([]);
    expect(stats.totalDomains).toBe(0);
    expect(stats.totalBlockedUsers).toBe(0);
  });
});

describe('admin.blacklistDomains.stats', () => {
  it('returns structurally valid shape (empty blacklist → empty domain list)', async () => {
    await insertTestUser({
      google_user_email: 'a@example.com',
      email_domain: 'example.com',
    });

    const caller = await createCallerForUser(admin.id);
    const stats = await caller.admin.blacklistDomains.stats();

    expect(stats).toMatchObject({
      domains: expect.any(Array),
      totalDomains: expect.any(Number),
      totalBlockedUsers: expect.any(Number),
    });
    // With BLACKLIST_DOMAINS unset in the test env and redis unavailable,
    // the procedure sees an empty blacklist and returns an empty per-domain
    // breakdown regardless of how many users exist.
    expect(stats.domains).toEqual([]);
    expect(stats.totalDomains).toBe(0);
    expect(stats.totalBlockedUsers).toBe(0);
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
    const result = await caller.admin.blacklistDomains.set({ domains: ['mailinator.com'] });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(mockedRedisSet).toHaveBeenCalledWith(
      BLACKLIST_DOMAINS_REDIS_KEY,
      expect.stringContaining('mailinator.com')
    );

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

  it('only backfills domains that were not already on the list', async () => {
    mockedRedisGet.mockResolvedValue(
      JSON.stringify({
        domains: ['mailinator.com'],
        updated_at: null,
        updated_by: null,
        updated_by_email: null,
      })
    );
    const existing = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com', 'spam.org'],
    });

    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });

    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, existing.id));
    expect(row.blocked_reason).toBeNull();
  });

  it('keeps the saved list when the automatic block fails', async () => {
    mockedBackfill.mockRejectedValue(new Error('database unavailable'));

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({ domains: ['mailinator.com'] });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: true });
    expect(mockedRedisSet).toHaveBeenCalled();
  });
});
