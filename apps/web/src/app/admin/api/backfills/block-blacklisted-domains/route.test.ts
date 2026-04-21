import { describe, it, expect, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, isNull } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { blacklistedDomainCondition } from './route';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function unblockedMatches(domains: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(and(isNull(kilocode_users.blocked_reason), blacklistedDomainCondition(domains)));
  return rows.map(r => r.id);
}

describe('blacklistedDomainCondition', () => {
  it('matches users whose email_domain equals a blacklist entry', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const other = await insertTestUser({
      google_user_email: 'b@legit.com',
      email_domain: 'legit.com',
    });

    const matches = await unblockedMatches(['mailinator.com']);

    expect(matches).toContain(user.id);
    expect(matches).not.toContain(other.id);
  });

  it('matches users whose email_domain is a subdomain of a blacklist entry', async () => {
    // The extractEmailDomain helper normalises most emails to their registrable
    // domain, but a few corner cases (e.g. public-suffix-list leaves like
    // `someone.github.io`) legitimately store a subdomain. Cover that case.
    const user = await insertTestUser({
      google_user_email: 'a@evil.mailinator.com',
      email_domain: 'evil.mailinator.com',
    });

    const matches = await unblockedMatches(['mailinator.com']);

    expect(matches).toContain(user.id);
  });

  it('does not match on label-boundary mismatches', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@notmailinator.com',
      email_domain: 'notmailinator.com',
    });

    const matches = await unblockedMatches(['mailinator.com']);

    expect(matches).not.toContain(user.id);
  });

  it('is case-insensitive on blacklist entries', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const matches = await unblockedMatches(['MAILINATOR.COM']);

    expect(matches).toContain(user.id);
  });

  it('excludes users that already have a blocked_reason set', async () => {
    const alreadyBlocked = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'abuse',
    });
    const unblocked = await insertTestUser({
      google_user_email: 'b@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const matches = await unblockedMatches(['mailinator.com']);

    expect(matches).not.toContain(alreadyBlocked.id);
    expect(matches).toContain(unblocked.id);
  });

  it('excludes users with a null email_domain', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: null,
    });

    const matches = await unblockedMatches(['mailinator.com']);

    expect(matches).not.toContain(user.id);
  });

  it('matches against multiple blacklist entries', async () => {
    const a = await insertTestUser({
      google_user_email: 'a@spam.org',
      email_domain: 'spam.org',
    });
    const b = await insertTestUser({
      google_user_email: 'b@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const c = await insertTestUser({
      google_user_email: 'c@legit.com',
      email_domain: 'legit.com',
    });

    const matches = await unblockedMatches(['mailinator.com', 'spam.org']);

    expect(matches).toContain(a.id);
    expect(matches).toContain(b.id);
    expect(matches).not.toContain(c.id);
  });

  it('matches nothing when the blacklist is empty', async () => {
    await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const matches = await unblockedMatches([]);

    expect(matches).toEqual([]);
  });

  it('ignores whitespace and casing in blacklist entries', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });

    const matches = await unblockedMatches(['  MAILINATOR.COM  ']);

    expect(matches).toContain(user.id);
  });
});
