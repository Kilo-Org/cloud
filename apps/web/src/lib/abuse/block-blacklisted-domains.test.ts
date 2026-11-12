import { describe, it, expect, beforeEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  backfillBlockBlacklistedDomainsBatch,
  countUnblockableDomainUsers,
  findBlacklistedEmailDomains,
  unblockBlacklistedDomainUsersBatch,
} from './block-blacklisted-domains';

beforeEach(async () => {
  await cleanupDbForTest();
});

async function unblockedMatches(domains: string[]): Promise<string[]> {
  const matchedDomains = (await findBlacklistedEmailDomains(domains)).map(row => row.email_domain);
  if (matchedDomains.length === 0) return [];
  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        isNull(kilocode_users.blocked_reason),
        inArray(kilocode_users.email_domain, matchedDomains)
      )
    );
  return rows.map(r => r.id);
}

describe('findBlacklistedEmailDomains', () => {
  it('returns each matching domain once with its unblocked user count', async () => {
    await insertTestUser({ google_user_email: 'a@mailinator.com', email_domain: 'mailinator.com' });
    await insertTestUser({ google_user_email: 'b@mailinator.com', email_domain: 'mailinator.com' });
    await insertTestUser({ google_user_email: 'c@legit.com', email_domain: 'legit.com' });

    const rows = await findBlacklistedEmailDomains(['mailinator.com']);

    expect(rows).toEqual([{ email_domain: 'mailinator.com', count: 2 }]);
  });

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

  it('handles a list large enough to exceed the bind-parameter limit', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@mailinator.com',
      email_domain: 'mailinator.com',
    });
    const filler = Array.from({ length: 35_000 }, (_, i) => `filler-${i}.example`);

    const matches = await unblockedMatches([...filler, 'mailinator.com']);

    expect(matches).toContain(user.id);
  });
});

describe('backfillBlockBlacklistedDomainsBatch', () => {
  it('blocks matching users and rotates their api_token_pepper', async () => {
    const admin = await insertTestUser({ is_admin: true });
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

    const result = await backfillBlockBlacklistedDomainsBatch({
      actorId: admin.id,
      domains: ['mailinator.com'],
    });
    expect(result.processed).toBe(1);

    const rows = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [target.id, safe.id]));
    const byId = new Map(rows.map(r => [r.id, r]));

    const blocked = byId.get(target.id);
    expect(blocked?.blocked_reason).toBe('domainblocked');
    expect(blocked?.blocked_by_kilo_user_id).toBe(admin.id);
    expect(blocked?.api_token_pepper).toEqual(expect.any(String));
    expect(blocked?.api_token_pepper).not.toBe('initial-pepper');

    // Non-matching users are untouched.
    const untouched = byId.get(safe.id);
    expect(untouched?.blocked_reason).toBeNull();
    expect(untouched?.api_token_pepper).toBe('safe-pepper');
  });

  it('does not block admin accounts', async () => {
    const adminUser = await insertTestUser({
      google_user_email: 'admin@mailinator.com',
      email_domain: 'mailinator.com',
      is_admin: true,
    });

    const result = await backfillBlockBlacklistedDomainsBatch({
      actorId: adminUser.id,
      domains: ['mailinator.com'],
    });
    expect(result.processed).toBe(0);

    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, adminUser.id));
    expect(row.blocked_reason).toBeNull();
  });

  it('does not overwrite or re-rotate an already-blocked user', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const already = await insertTestUser({
      google_user_email: 'c@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'prior reason',
      api_token_pepper: 'prior-pepper',
    });

    const result = await backfillBlockBlacklistedDomainsBatch({
      actorId: admin.id,
      domains: ['mailinator.com'],
    });
    expect(result.processed).toBe(0);

    const [row] = await db
      .select({
        blocked_reason: kilocode_users.blocked_reason,
        api_token_pepper: kilocode_users.api_token_pepper,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, already.id));
    expect(row.blocked_reason).toBe('prior reason');
    expect(row.api_token_pepper).toBe('prior-pepper');
  });
});

describe('countUnblockableDomainUsers', () => {
  it('splits matching domain-blocked users by positive balance', async () => {
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

    await expect(
      countUnblockableDomainUsers({ domain: 'mailinator.com', remainingDomains: [] })
    ).resolves.toEqual({ unblockable: 1, keptBlocked: 1 });
  });

  it('excludes users still matched by a remaining blacklist entry', async () => {
    await insertTestUser({
      google_user_email: 'a@sub.mailinator.com',
      email_domain: 'sub.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    await expect(
      countUnblockableDomainUsers({
        domain: 'sub.mailinator.com',
        remainingDomains: ['mailinator.com'],
      })
    ).resolves.toEqual({ unblockable: 0, keptBlocked: 0 });
  });
});

describe('unblockBlacklistedDomainUsersBatch', () => {
  it('unblocks only positive-balance domain blocks and keeps rotated peppers', async () => {
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
    const admin = await insertTestUser({
      google_user_email: 'f@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'domainblocked',
      is_admin: true,
      total_microdollars_acquired: 100,
    });
    const deleted = await insertTestUser({
      google_user_email: 'g@mailinator.com',
      email_domain: 'mailinator.com',
      blocked_reason: 'soft-deleted at 2026-01-01T00:00:00.000Z',
      total_microdollars_acquired: 100,
    });
    const other = await insertTestUser({
      google_user_email: 'h@legit.com',
      email_domain: 'legit.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    const result = await unblockBlacklistedDomainUsersBatch({
      domain: 'mailinator.com',
      remainingDomains: [],
      positiveBalanceOnly: true,
    });

    expect(result).toEqual({ processed: 2, remaining: false, keptBlocked: 2 });

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
          admin.id,
          deleted.id,
          other.id,
        ])
      );
    const byId = new Map(rows.map(row => [row.id, row]));

    expect(byId.get(target.id)).toMatchObject({
      blocked_reason: null,
      blocked_at: null,
      blocked_by_kilo_user_id: null,
      api_token_pepper: 'rotated-pepper',
    });
    expect(byId.get(subdomain.id)?.blocked_reason).toBeNull();
    expect(byId.get(zeroBalance.id)?.blocked_reason).toBe('domainblocked');
    expect(byId.get(negativeBalance.id)?.blocked_reason).toBe('domainblocked');
    expect(byId.get(manual.id)?.blocked_reason).toBe('manual');
    expect(byId.get(admin.id)?.blocked_reason).toBe('domainblocked');
    expect(byId.get(deleted.id)?.blocked_reason).toBe('soft-deleted at 2026-01-01T00:00:00.000Z');
    expect(byId.get(other.id)?.blocked_reason).toBe('domainblocked');
  });

  it('leaves users blocked while a remaining entry still matches them', async () => {
    const user = await insertTestUser({
      google_user_email: 'a@sub.mailinator.com',
      email_domain: 'sub.mailinator.com',
      blocked_reason: 'domainblocked',
      total_microdollars_acquired: 100,
    });

    const result = await unblockBlacklistedDomainUsersBatch({
      domain: 'sub.mailinator.com',
      remainingDomains: ['mailinator.com'],
      positiveBalanceOnly: true,
    });

    expect(result).toEqual({ processed: 0, remaining: false, keptBlocked: 0 });
    const [row] = await db
      .select({ blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(row.blocked_reason).toBe('domainblocked');
  });
});
