import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS,
  canSpendPaidUsage,
  createEmailDomainBlacklistCache,
  emailDomainSuffixes,
  findBlacklistedDomains,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  requestOrganizationId,
} from './account-access';

const organization = { total_microdollars_acquired: 5_000, microdollars_used: 1_000 };

describe('account access rules', () => {
  it('lets a signed organization claim win over the mutable header', () => {
    expect(requestOrganizationId('signed-org', 'header-org')).toBe('signed-org');
    expect(requestOrganizationId(undefined, 'header-org')).toBe('header-org');
    expect(requestOrganizationId(undefined, null)).toBeUndefined();
  });

  it('accepts any token for an account without a pepper and otherwise requires the current one', () => {
    expect(isApiTokenPepperCurrent(null, undefined)).toBe(true);
    expect(isApiTokenPepperCurrent('current', 'current')).toBe(true);
    expect(isApiTokenPepperCurrent('current', 'rotated')).toBe(false);
    expect(isApiTokenPepperCurrent('current', undefined)).toBe(false);
  });

  it('ignores member limits for seat-based organizations and unlimited members', () => {
    const limited = { microdollar_limit: 500, microdollar_usage: 500 };
    expect(organizationMemberBalance({ ...organization, ...limited, require_seats: true })).toEqual(
      { balanceMicrodollars: 4_000, limitedByUserAllowance: false }
    );
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: null,
        microdollar_usage: null,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 4_000, limitedByUserAllowance: false });
  });

  it('caps a limited member at the smaller of allowance and organization balance', () => {
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 1_500,
        microdollar_usage: 500,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 1_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 9_000,
        microdollar_usage: null,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: 4_000, limitedByUserAllowance: false });
    expect(
      organizationMemberBalance({
        ...organization,
        microdollar_limit: 500,
        microdollar_usage: 700,
        require_seats: false,
      })
    ).toEqual({ balanceMicrodollars: -200, limitedByUserAllowance: true });
  });

  it('requires a positive balance for paid usage', () => {
    expect(canSpendPaidUsage(0.000001)).toBe(true);
    expect(canSpendPaidUsage(0)).toBe(false);
    expect(canSpendPaidUsage(-1)).toBe(false);
  });

  it('blocks a listed email domain and its subdomains, case-insensitively', () => {
    const domains = ['Spam.com'];
    expect(isEmailBlacklistedByDomain('user@SPAM.com', domains)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@mail.spam.com', domains)).toBe(true);
    expect(isEmailBlacklistedByDomain('user@notspam.com', domains)).toBe(false);
    expect(isEmailBlacklistedByDomain('spam.com@legitimate.org', domains)).toBe(false);
    expect(isEmailBlacklistedByDomain('user@spam.com', undefined)).toBe(false);
  });

  it('matches a list entry that sits several labels above the host', () => {
    expect(isEmailBlacklistedByDomain('user@a.b.c.spam.com', ['spam.com'])).toBe(true);
    expect(isEmailBlacklistedByDomain('user@a.b.c.spam.com', ['b.c.spam.com'])).toBe(true);
    expect(isEmailBlacklistedByDomain('user@a.b.c.spam.com', ['c.spam.com.other.org'])).toBe(false);
  });

  it('does not reuse an index built for a different list', () => {
    expect(isEmailBlacklistedByDomain('user@spam.com', ['spam.com'])).toBe(true);
    expect(isEmailBlacklistedByDomain('user@spam.com', ['safe.com'])).toBe(false);
    expect(isEmailBlacklistedByDomain('user@spam.com', ['spam.com'])).toBe(true);
  });

  it('matches a bare host only through a dotted suffix', () => {
    expect(isEmailBlacklistedByDomain('spam.com', ['spam.com'])).toBe(false);
    expect(isEmailBlacklistedByDomain('a.spam.com', ['spam.com'])).toBe(true);
  });

  it('matches a bare TLD entry against every address on that TLD', () => {
    expect(isEmailBlacklistedByDomain('user@example.asia', ['asia'])).toBe(true);
    // A host equal to the entry also matches; only off-boundary suffixes do not.
    expect(isEmailBlacklistedByDomain('user@asia', ['asia'])).toBe(true);
    expect(isEmailBlacklistedByDomain('user@notasia.com', ['asia'])).toBe(false);
  });
});

const dialect = new PgDialect();

// Answers `select domain from blacklisted_domains where domain in (...)` from the given rows,
// recording each lookup's rendered SQL and domains.
function blacklistDb(blockedDomains: readonly string[], options: { fail?: () => boolean } = {}) {
  const lookups: { sql: string; domains: string[] }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          const query = dialect.sqlToQuery(condition);
          const domains = query.params.map(String);
          lookups.push({ sql: query.sql, domains });
          if (options.fail?.()) throw new Error('database unavailable');
          return domains
            .filter(domain => blockedDomains.includes(domain))
            .map(domain => ({ domain }));
        },
      }),
    }),
  };
  return { db: db as never, lookups };
}

describe('emailDomainSuffixes', () => {
  it('lists the host and its label-boundary suffixes, longest first and lowercased', () => {
    expect(emailDomainSuffixes('user@a.b.com')).toEqual(['a.b.com', 'b.com', 'com']);
    expect(emailDomainSuffixes('User@Mail.EXAMPLE.com')).toEqual([
      'mail.example.com',
      'example.com',
      'com',
    ]);
    expect(emailDomainSuffixes('user@localhost')).toEqual(['localhost']);
  });

  it('takes the host after the last @', () => {
    expect(emailDomainSuffixes('spam.com@legit.org')).toEqual(['legit.org', 'org']);
  });

  it('yields only dotted suffixes for an address without @', () => {
    expect(emailDomainSuffixes('something.evil.com')).toEqual(['evil.com', 'com']);
    expect(emailDomainSuffixes('evil')).toEqual([]);
  });

  it('yields nothing for an empty host and skips the empty suffix after a trailing dot', () => {
    expect(emailDomainSuffixes('')).toEqual([]);
    expect(emailDomainSuffixes('user@')).toEqual([]);
    expect(emailDomainSuffixes('user@evil.com.')).toEqual(['evil.com.', 'com.']);
  });

  it('skips suffixes longer than a DNS name', () => {
    const longestName = `${'a'.repeat(249)}.com`;
    expect(longestName).toHaveLength(253);
    expect(emailDomainSuffixes(`user@${longestName}`)).toEqual([longestName, 'com']);
    expect(emailDomainSuffixes(`user@x.${longestName}`)).toEqual([longestName, 'com']);
    expect(emailDomainSuffixes(`user@a${longestName}`)).toEqual(['com']);
  });

  it('bounds the suffixes of a very long host and still finds its short suffixes', () => {
    const host = `${'a.'.repeat(100_000)}evil.com`;
    const started = performance.now();
    const suffixes = emailDomainSuffixes(`user@${host}`);
    expect(performance.now() - started).toBeLessThan(1_000);

    expect(suffixes.every(suffix => suffix.length <= 253)).toBe(true);
    // 'com', 'evil.com', and each 'a.'-prefixed suffix that fits in 253 characters.
    expect(suffixes).toHaveLength(124);
    expect(suffixes.slice(-3)).toEqual(['a.evil.com', 'evil.com', 'com']);
  });
});

describe('email domain blacklist lookups', () => {
  it('blocks an address whose parent domain is listed, in one IN lookup', async () => {
    const { db, lookups } = blacklistDb(['example.com']);
    const cache = createEmailDomainBlacklistCache();

    expect(await cache.isBlacklisted(db, 'dev@Mail.Example.com')).toBe(true);
    expect(lookups).toEqual([
      {
        sql: '"blacklisted_domains"."domain" in ($1, $2, $3)',
        domains: ['mail.example.com', 'example.com', 'com'],
      },
    ]);
  });

  it('admits an address whose suffixes are not listed', async () => {
    const { db } = blacklistDb(['example.com']);
    const cache = createEmailDomainBlacklistCache();

    expect(await cache.isBlacklisted(db, 'dev@notexample.com')).toBe(false);
    expect(await cache.isBlacklisted(db, 'example.com@legit.org')).toBe(false);
  });

  it('does not query for an address or domain list without suffixes', async () => {
    const { db, lookups } = blacklistDb(['example.com']);
    const cache = createEmailDomainBlacklistCache();

    expect(await cache.isBlacklisted(db, 'user@')).toBe(false);
    expect(await findBlacklistedDomains(db, [])).toEqual(new Set());
    expect(lookups).toHaveLength(0);
  });

  it('finds which of several domains are listed in one lookup', async () => {
    const { db, lookups } = blacklistDb(['spam.com', 'junk.org']);

    expect(await findBlacklistedDomains(db, ['spam.com', 'legit.org', 'junk.org'])).toEqual(
      new Set(['spam.com', 'junk.org'])
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.sql).toBe('"blacklisted_domains"."domain" in ($1, $2, $3)');
  });
});

describe('createEmailDomainBlacklistCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers the same host from the cache within the TTL', async () => {
    const { db, lookups } = blacklistDb(['example.com']);
    const cache = createEmailDomainBlacklistCache();

    expect(await cache.isBlacklisted(db, 'a@mail.example.com')).toBe(true);
    expect(await cache.isBlacklisted(db, 'b@MAIL.example.com')).toBe(true);
    expect(lookups).toHaveLength(1);

    expect(await cache.isBlacklisted(db, 'a@example.com')).toBe(true);
    expect(lookups).toHaveLength(2);
  });

  it('looks the host up again once the TTL has passed', async () => {
    let time = 0;
    const { db, lookups } = blacklistDb([]);
    const cache = createEmailDomainBlacklistCache({ now: () => time });

    await cache.isBlacklisted(db, 'dev@example.com');
    time = EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS - 1;
    await cache.isBlacklisted(db, 'dev@example.com');
    expect(lookups).toHaveLength(1);

    time = EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS;
    await cache.isBlacklisted(db, 'dev@example.com');
    expect(lookups).toHaveLength(2);
  });

  it('caches the answer once the first lookup resolves', async () => {
    const { db, lookups } = blacklistDb(['example.com']);
    const cache = createEmailDomainBlacklistCache();

    expect(await cache.isBlacklisted(db, 'a@example.com')).toBe(true);
    expect(lookups).toHaveLength(1);

    expect(await cache.isBlacklisted(db, 'b@example.com')).toBe(true);
    expect(lookups).toHaveLength(1);
  });

  it('expires answers on the system clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { db, lookups } = blacklistDb([]);
    const cache = createEmailDomainBlacklistCache();

    await cache.isBlacklisted(db, 'dev@example.com');
    vi.setSystemTime(EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS - 1);
    await cache.isBlacklisted(db, 'dev@example.com');
    expect(lookups).toHaveLength(1);

    vi.setSystemTime(EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS);
    await cache.isBlacklisted(db, 'dev@example.com');
    expect(lookups).toHaveLength(2);
  });

  it('does not cache a failed lookup', async () => {
    let failing = true;
    const { db, lookups } = blacklistDb(['example.com'], { fail: () => failing });
    const cache = createEmailDomainBlacklistCache();

    await expect(cache.isBlacklisted(db, 'dev@example.com')).rejects.toThrow(
      'database unavailable'
    );
    failing = false;
    expect(await cache.isBlacklisted(db, 'dev@example.com')).toBe(true);
    expect(lookups).toHaveLength(2);
  });

  it('forgets every answer on clear', async () => {
    const { db, lookups } = blacklistDb([]);
    const cache = createEmailDomainBlacklistCache();

    await cache.isBlacklisted(db, 'dev@example.com');
    cache.clear();
    await cache.isBlacklisted(db, 'dev@example.com');
    expect(lookups).toHaveLength(2);
  });

  it('evicts the oldest host beyond 10,000 entries', async () => {
    const { db, lookups } = blacklistDb([]);
    const cache = createEmailDomainBlacklistCache();

    for (let i = 0; i <= 10_000; i++) await cache.isBlacklisted(db, `dev@host${i}.test`);
    expect(lookups).toHaveLength(10_001);

    await cache.isBlacklisted(db, 'dev@host1.test');
    expect(lookups).toHaveLength(10_001);
    await cache.isBlacklisted(db, 'dev@host0.test');
    expect(lookups).toHaveLength(10_002);
  });
});
