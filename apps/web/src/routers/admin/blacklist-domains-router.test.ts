import { describe, expect, it, beforeEach } from '@jest/globals';
import { cleanupDbForTest } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { isDomainOnBlacklist } from './blacklist-domains-router';
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
    for (let i = 0; i < 5; i++) {
      await insertTestUser({
        google_user_email: `u${i}@more-users.com`,
        email_domain: 'more-users.com',
      });
    }
    for (let i = 0; i < 2; i++) {
      await insertTestUser({
        google_user_email: `u${i}@fewer-users-but-blocked.com`,
        email_domain: 'fewer-users-but-blocked.com',
        blocked_reason: 'abuse',
      });
    }

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const ordered = domains.map(d => d.domain);
    expect(ordered.indexOf('fewer-users-but-blocked.com')).toBeLessThan(
      ordered.indexOf('more-users.com')
    );
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
    });

    const caller = await createCallerForUser(admin.id);
    const { domains } = await caller.admin.blacklistDomains.suspicious();

    const example = domains.find(d => d.domain === 'example.com');
    expect(example).toBeDefined();
    expect(typeof example!.firstSeen).toBe('string');
    expect(typeof example!.lastSeen).toBe('string');
  });
});
