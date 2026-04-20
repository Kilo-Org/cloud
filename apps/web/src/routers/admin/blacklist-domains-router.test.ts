import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { computeBlacklistStats, isDomainOnBlacklist } from './blacklist-domains-router';
import type { User } from '@kilocode/db/schema';

let admin: User;

beforeEach(async () => {
  await cleanupDbForTest();
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

  it('hides domains with fewer than 1% of accounts blocked', async () => {
    // noisy.com: 99 clean users + 0 blocked → 0% → filtered out
    for (let i = 0; i < 99; i++) {
      await insertTestUser({
        google_user_email: `u${i}@noisy.com`,
        email_domain: 'noisy.com',
      });
    }
    // just-under.com: 99 clean + 0 blocked → filtered out (0%)
    // over-threshold.com: 99 clean + 1 blocked → 1% → surfaced
    for (let i = 0; i < 99; i++) {
      await insertTestUser({
        google_user_email: `u${i}@over-threshold.com`,
        email_domain: 'over-threshold.com',
      });
    }
    await insertTestUser({
      google_user_email: 'b@over-threshold.com',
      email_domain: 'over-threshold.com',
      blocked_reason: 'abuse',
    });

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const names = domains.map(d => d.domain);
    expect(names).toContain('over-threshold.com');
    expect(names).not.toContain('noisy.com');
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
