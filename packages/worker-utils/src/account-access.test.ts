import { describe, expect, it } from 'vitest';
import {
  BLACKLISTED_DOMAINS_REDIS_KEY,
  BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY,
  canSpendPaidUsage,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  refreshBlacklistedDomains,
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
});

describe('refreshBlacklistedDomains', () => {
  const FULL_READ_INTERVAL_MS = 10 * 60_000;

  function fakeRedis(entries: Record<string, string>) {
    const reads: string[] = [];
    return {
      reads,
      store: entries,
      get: async (key: string) => {
        reads.push(key);
        return entries[key] ?? null;
      },
    };
  }

  function storeList(
    redis: ReturnType<typeof fakeRedis>,
    domains: string[],
    updatedAt: string | null,
    { writeUpdatedAtKey = true } = {}
  ) {
    redis.store[BLACKLISTED_DOMAINS_REDIS_KEY] = JSON.stringify({
      domains,
      updated_at: updatedAt,
      updated_by: null,
      updated_by_email: null,
    });
    if (writeUpdatedAtKey && updatedAt) {
      redis.store[BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY] = updatedAt;
    }
  }

  it('reads the stored list and falls back when it is empty or missing', async () => {
    const redis = fakeRedis({});
    expect((await refreshBlacklistedDomains(redis.get, null, ['env.com'], 0)).domains).toEqual([
      'env.com',
    ]);

    storeList(redis, [], 't1');
    expect((await refreshBlacklistedDomains(redis.get, null, ['env.com'], 0)).domains).toEqual([
      'env.com',
    ]);

    storeList(redis, ['spam.com'], 't2');
    expect(await refreshBlacklistedDomains(redis.get, null, ['env.com'], 0)).toEqual({
      domains: ['spam.com'],
      updatedAt: 't2',
      fullReadAt: 0,
    });
  });

  it('keeps the previous snapshot without downloading the list while updated_at is unchanged', async () => {
    const redis = fakeRedis({});
    storeList(redis, ['spam.com'], 't1');
    const first = await refreshBlacklistedDomains(redis.get, null, [], 0);
    redis.reads.length = 0;

    const second = await refreshBlacklistedDomains(redis.get, first, [], 60_000);

    expect(second).toBe(first);
    expect(redis.reads).toEqual([BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY]);
  });

  it('downloads the list once updated_at changes', async () => {
    const redis = fakeRedis({});
    storeList(redis, ['spam.com'], 't1');
    const first = await refreshBlacklistedDomains(redis.get, null, [], 0);
    storeList(redis, ['spam.com', 'junk.org'], 't2');

    const second = await refreshBlacklistedDomains(redis.get, first, [], 60_000);

    expect(second).toEqual({
      domains: ['spam.com', 'junk.org'],
      updatedAt: 't2',
      fullReadAt: 60_000,
    });
  });

  it('downloads the list every time when the updated_at key was never written', async () => {
    const redis = fakeRedis({});
    storeList(redis, ['spam.com'], 't1', { writeUpdatedAtKey: false });
    const first = await refreshBlacklistedDomains(redis.get, null, [], 0);
    storeList(redis, ['junk.org'], 't2', { writeUpdatedAtKey: false });

    expect((await refreshBlacklistedDomains(redis.get, first, [], 60_000)).domains).toEqual([
      'junk.org',
    ]);
  });

  it('downloads the list after the full-read interval even when updated_at is unchanged', async () => {
    const redis = fakeRedis({});
    storeList(redis, ['spam.com'], 't1');
    const first = await refreshBlacklistedDomains(redis.get, null, [], 0);
    storeList(redis, ['junk.org'], 't1');

    expect(await refreshBlacklistedDomains(redis.get, first, [], FULL_READ_INTERVAL_MS - 1)).toBe(
      first
    );
    expect(
      (await refreshBlacklistedDomains(redis.get, first, [], FULL_READ_INTERVAL_MS)).domains
    ).toEqual(['junk.org']);
  });
});
