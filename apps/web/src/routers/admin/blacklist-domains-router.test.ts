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
  },
}));

import { describe, expect, it, beforeEach } from '@jest/globals';
import { createHash } from 'node:crypto';
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
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import type { User } from '@kilocode/db/schema';
import { MAX_BLACKLIST_DOMAINS } from '@kilocode/worker-utils/account-access';

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
const redisValues = new Map<string, string>();

const saveFailureMessage =
  'Redis may already be updated. Reload and retry to synchronize Postgres, then run the account backfill.';
const conflictMessage = 'Blacklist changed. Reload the complete list before saving.';

function configVersion(raw = redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? '') {
  return createHash('sha256').update(raw).digest('hex');
}

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  redisValues.clear();
  mockedRedisGet.mockReset();
  mockedRedisGet.mockImplementation(async <T>(key: string) => {
    return (redisValues.get(key) ?? null) as T | null;
  });
  mockedRedisMset.mockReset();
  mockedRedisMset.mockImplementation(async values => {
    for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
    return 'OK';
  });
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
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 1, remaining: false, failed: false });
    expect(mockedRedisMset).toHaveBeenCalledWith({
      [BLACKLIST_DOMAINS_REDIS_KEY]: JSON.stringify({
        domains: ['mailinator.com'],
        blocked_signup_tlds: result.blocked_signup_tlds,
        updated_at: result.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      }),
      [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: result.updated_at,
    });
    expect(result.updated_at).toEqual(expect.any(String));
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'mailinator.com' }]);

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

  it('replaces the full normalized snapshot but only backfills newly added domains', async () => {
    await db
      .insert(blacklisted_domains)
      .values([{ domain: 'mailinator.com' }, { domain: 'removed.example' }]);
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: [' MAILINATOR.COM ', 'removed.example'],
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
      domains: [' MAILINATOR.COM ', 'Spam.ORG', 'spam.org', '   '],
      expected_version: configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com', 'spam.org']);
    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      [{ domain: 'mailinator.com' }, { domain: 'spam.org' }]
    );
    expect(JSON.parse(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? 'null').domains).toEqual([
      'mailinator.com',
      'spam.org',
    ]);
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
    'removes domains from both stores without backfilling: $domains',
    async ({ domains: remainingDomains }) => {
      const previous = {
        domains: ['mailinator.com', 'removed.example'],
        blocked_signup_tlds: ['asia'],
        updated_at: null,
        updated_by: null,
        updated_by_email: null,
      };
      redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(previous));
      await db.insert(blacklisted_domains).values(previous.domains.map(domain => ({ domain })));
      const caller = await createCallerForUser(admin.id);

      const result = await caller.admin.blacklistDomains.set({
        domains: remainingDomains,
        expected_version: configVersion(),
      });

      expect(result.domains).toEqual(remainingDomains);
      expect(await db.select().from(blacklisted_domains)).toEqual(
        remainingDomains.map(domain => ({ domain }))
      );
      expect(JSON.parse(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? 'null')).toEqual({
        domains: remainingDomains,
        blocked_signup_tlds: ['asia'],
        updated_at: result.updated_at,
        updated_by: admin.id,
        updated_by_email: admin.google_user_email,
      });
      expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(result.updated_at);
      expect(mockedBackfill).not.toHaveBeenCalled();
    }
  );

  it('commits the snapshot before starting the existing-account backfill', async () => {
    let committedDomains: { domain: string }[] | undefined;
    mockedBackfill.mockImplementationOnce(async () => {
      committedDomains = await db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE NOWAIT`);
        return tx.select().from(blacklisted_domains);
      });
      return { processed: 0, remaining: false };
    });
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: configVersion(),
    });

    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(committedDomains).toEqual([{ domain: 'mailinator.com' }]);
  });

  it('keeps the saved list when the automatic block fails', async () => {
    mockedBackfill.mockRejectedValue(new Error('database unavailable'));

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: configVersion(),
    });

    expect(result.domains).toEqual(['mailinator.com']);
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: true });
    expect(mockedRedisMset).toHaveBeenCalled();
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'mailinator.com' }]);
  });

  it('fails without changing either store when the previous config cannot be read', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'previous.example' });
    mockedRedisGet.mockRejectedValue(new Error('redis unavailable'));

    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: configVersion(),
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining(saveFailureMessage),
    });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(mockedRedisMset).not.toHaveBeenCalled();
  });

  it('rejects a stale complete snapshot before changing either store', async () => {
    const previous = {
      domains: ['first.example', 'second.example'],
      blocked_signup_tlds: ['asia'],
      updated_at: null,
      updated_by: null,
      updated_by_email: null,
    };
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(previous));
    const caller = await createCallerForUser(admin.id);
    const loaded = await caller.admin.blacklistDomains.get();
    const currentDomains = [...previous.domains, 'third.example'];
    const current = JSON.stringify({ ...previous, domains: currentDomains });
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, current);
    await db.insert(blacklisted_domains).values(currentDomains.map(domain => ({ domain })));

    await expect(
      caller.admin.blacklistDomains.set({
        domains: loaded.domains,
        blocked_tlds: ['shop'],
        expected_version: loaded.version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: conflictMessage });

    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(current);
    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      currentDomains.map(domain => ({ domain }))
    );
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('rejects a predeploy editor capped prefix without a version before reading or writing Redis', async () => {
    const domains = Array.from({ length: MAX_BLACKLIST_DOMAINS + 5 }, (_, i) => `bulk${i}.example`);
    const raw = JSON.stringify({
      domains,
      blocked_signup_tlds: ['asia'],
      updated_at: null,
      updated_by: null,
      updated_by_email: null,
    });
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, raw);
    const tailDomain = domains[MAX_BLACKLIST_DOMAINS];
    await db.insert(blacklisted_domains).values({ domain: tailDomain });
    const caller = await createCallerForUser(admin.id);
    const oldInput = { domains: domains.slice(0, MAX_BLACKLIST_DOMAINS), blocked_tlds: ['shop'] };

    await expect(
      caller.admin.blacklistDomains.set(
        oldInput as Parameters<typeof caller.admin.blacklistDomains.set>[0]
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: tailDomain }]);
    expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(raw);
    expect(mockedRedisGet).not.toHaveBeenCalled();
    expect(mockedRedisMset).not.toHaveBeenCalled();
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('preserves the table and skips backfill when the Redis write fails', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'previous.example' });
    mockedRedisMset.mockRejectedValue(new Error('redis write failed'));
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.blacklistDomains.set({
        domains: ['mailinator.com'],
        expected_version: configVersion(),
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining(saveFailureMessage),
    });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('retains an ambiguously applied Redis write and repairs Postgres after reloading its version', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'previous.example' });
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: ['previous.example'],
        blocked_signup_tlds: ['asia'],
        updated_at: '2026-01-01T00:00:00.000Z',
        updated_by: null,
        updated_by_email: null,
      })
    );
    redisValues.set(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY, '2026-01-01T00:00:00.000Z');
    mockedRedisMset.mockImplementationOnce(async values => {
      for (const [key, value] of Object.entries(values)) redisValues.set(key, String(value));
      throw new Error('Redis applied MSET but its response was lost');
    });
    const caller = await createCallerForUser(admin.id);
    const domains = ['new.example', 'previous.example'];
    const input = { domains, expected_version: configVersion() };

    await expect(caller.admin.blacklistDomains.set(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: expect.stringContaining(saveFailureMessage),
    });

    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
    const liveConfig = JSON.parse(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? 'null');
    expect(liveConfig).toEqual({
      domains,
      blocked_signup_tlds: ['asia'],
      updated_at: expect.any(String),
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
    });
    expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(liveConfig.updated_at);

    await expect(caller.admin.blacklistDomains.set(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: conflictMessage,
    });
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);

    const loaded = await caller.admin.blacklistDomains.get();
    expect(loaded.version).toBe(configVersion());
    expect(loaded.version).not.toBe(input.expected_version);
    const result = await caller.admin.blacklistDomains.set({
      domains: loaded.domains,
      expected_version: loaded.version,
    });

    expect(await db.select().from(blacklisted_domains).orderBy(blacklisted_domains.domain)).toEqual(
      domains.map(domain => ({ domain }))
    );
    expect(result.backfill).toEqual({ blocked: 0, remaining: false, failed: false });
    expect(mockedRedisMset).toHaveBeenCalledTimes(2);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it('leaves both stores intact on a second-batch failure and backfills new domains on retry', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'previous.example' });
    const previous = JSON.stringify({
      domains: ['previous.example'],
      blocked_signup_tlds: ['asia'],
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'previous-admin',
      updated_by_email: 'previous-admin@example.com',
    });
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, previous);
    redisValues.set(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY, '2026-01-01T00:00:00.000Z');
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
    const input = { domains, expected_version: configVersion() };
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
        message: expect.stringContaining(saveFailureMessage),
        cause: { cause: { message: 'forced second blacklist batch failure' } },
      });

      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
      expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(previous);
      expect(redisValues.get(BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY)).toBe(
        '2026-01-01T00:00:00.000Z'
      );
      expect(mockedRedisMset).not.toHaveBeenCalled();
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

  it('serializes saves before the Redis read and rejects the stale concurrent version', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify({
        domains: [],
        blocked_signup_tlds: ['shop'],
        updated_at: null,
        updated_by: null,
        updated_by_email: null,
      })
    );
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
    const expectedVersion = configVersion();
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
      expect(await db.select().from(blacklisted_domains)).toEqual([]);
      releaseFirst.resolve();
      const firstResult = await first;
      await secondFailure;

      expect(firstResult.blocked_signup_tlds).toEqual(['asia']);
      expect(mockedRedisGet).toHaveBeenCalledTimes(2);
      expect(mockedRedisMset).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledTimes(1);
      expect(mockedBackfill).toHaveBeenCalledWith({
        actorId: admin.id,
        domains: ['first.example'],
      });
      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'first.example' }]);
      expect(JSON.parse(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? 'null')).toEqual({
        domains: firstResult.domains,
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
    const result = await caller.admin.blacklistDomains.set({
      domains: [],
      blocked_tlds: ['  .ASIA  ', 'shop', 'asia'],
      expected_version: configVersion(),
    });

    expect(result.blocked_signup_tlds).toEqual(['asia', 'shop']);
    const [written] = mockedRedisMset.mock.calls.at(-1) ?? [];
    expect(JSON.parse(String(written?.[BLACKLIST_DOMAINS_REDIS_KEY])).blocked_signup_tlds).toEqual([
      'asia',
      'shop',
    ]);

    // A TLD gates new signups only, so existing accounts stay untouched.
    expect(mockedBackfill).not.toHaveBeenCalled();
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, onDomain.id));
    expect(row.blocked_reason).toBeNull();
  });

  it('keeps signup TLDs from the prior completed save when the field is omitted', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      blocked_tlds: ['asia'],
      expected_version: configVersion(),
    });
    const loaded = await caller.admin.blacklistDomains.get();
    mockedBackfill.mockClear();
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com', 'spam.org'],
      expected_version: loaded.version,
    });

    expect(result.blocked_signup_tlds).toEqual(['asia']);
    expect(
      JSON.parse(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY) ?? 'null').blocked_signup_tlds
    ).toEqual(['asia']);
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).toHaveBeenCalledWith({ actorId: admin.id, domains: ['spam.org'] });
  });

  it('keeps the effective TLD fallback when no config is stored yet', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.blacklistDomains.set({
      domains: ['mailinator.com'],
      expected_version: configVersion(),
    });

    // The stored config is written with the effective list auth enforces, not
    // an empty field that would silently re-allow every TLD.
    expect(result.blocked_signup_tlds).toEqual(['shop', 'top']);
  });
});

describe('admin.blacklistDomains.get', () => {
  it('shows the effective TLD list when no config is stored yet', async () => {
    mockedRedisGet.mockResolvedValue(null);

    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config.blocked_signup_tlds).toEqual(['shop', 'top']);
    expect(config.version).toBe(configVersion(''));
  });

  it('reports zero dropped entries and hashes the exact stored JSON including whitespace', async () => {
    redisValues.set(
      BLACKLIST_DOMAINS_REDIS_KEY,
      JSON.stringify(
        {
          domains: ['mailinator.com', 'spam.org'],
          updated_at: null,
          updated_by: null,
          updated_by_email: null,
        },
        null,
        2
      )
    );

    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config.domains).toEqual(['mailinator.com', 'spam.org']);
    expect(config.dropped_domains).toBe(0);
    expect(config.version).toBe(configVersion());
  });

  it.each(['', 'not-json'])(
    'rejects malformed stored config %j on get and save without writes',
    async raw => {
      redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, raw);
      await db.insert(blacklisted_domains).values({ domain: 'previous.example' });
      const caller = await createCallerForUser(admin.id);

      await expect(caller.admin.blacklistDomains.get()).rejects.toThrow();
      await expect(
        caller.admin.blacklistDomains.set({
          domains: ['mailinator.com'],
          expected_version: configVersion(raw),
        })
      ).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: expect.stringContaining(saveFailureMessage),
      });

      expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'previous.example' }]);
      expect(redisValues.get(BLACKLIST_DOMAINS_REDIS_KEY)).toBe(raw);
      expect(mockedRedisMset).not.toHaveBeenCalled();
      expect(mockedBackfill).not.toHaveBeenCalled();
    }
  );

  it('round-trips an over-cap editor snapshot and TLD-only save without backfilling the tail', async () => {
    const domains = Array.from({ length: MAX_BLACKLIST_DOMAINS + 5 }, (_, i) => `bulk${i}.example`);
    const previous = {
      domains,
      blocked_signup_tlds: ['shop'],
      updated_at: '2026-01-01T00:00:00.000Z',
      updated_by: 'previous-admin',
      updated_by_email: 'previous-admin@example.com',
    };
    redisValues.set(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(previous));
    await db.insert(blacklisted_domains).values({ domain: 'stale.example' });
    const tail = domains.slice(MAX_BLACKLIST_DOMAINS);
    const user = await insertTestUser({
      google_user_email: `existing@${tail[0]}`,
      email_domain: tail[0],
    });

    const caller = await createCallerForUser(admin.id);
    const config = await caller.admin.blacklistDomains.get();

    expect(config).toEqual({ ...previous, version: configVersion(), dropped_domains: 5 });
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
    expect(
      await db
        .select()
        .from(blacklisted_domains)
        .where(eq(blacklisted_domains.domain, 'stale.example'))
    ).toEqual([]);
    const savedConfig = {
      domains,
      blocked_signup_tlds: ['asia'],
      updated_at: result.updated_at,
      updated_by: admin.id,
      updated_by_email: admin.google_user_email,
    };
    expect(mockedRedisMset).toHaveBeenCalledTimes(1);
    expect(mockedRedisMset).toHaveBeenCalledWith({
      [BLACKLIST_DOMAINS_REDIS_KEY]: JSON.stringify(savedConfig),
      [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: result.updated_at,
    });
    expect(await caller.admin.blacklistDomains.get()).toEqual({
      ...savedConfig,
      version: configVersion(JSON.stringify(savedConfig)),
      dropped_domains: 5,
    });
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBeNull();
  }, 30000);
});
