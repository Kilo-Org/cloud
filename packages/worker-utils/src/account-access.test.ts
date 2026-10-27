import { describe, expect, it } from 'vitest';
import {
  BLACKLISTED_DOMAINS_REDIS_KEY,
  BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY,
  blacklistedDomainsFromConfig,
  blockedSignupTldsFromConfig,
  canSpendPaidUsage,
  isApiTokenPepperCurrent,
  isEmailBlacklistedByDomain,
  organizationMemberBalance,
  refreshBlacklistDomainsConfig,
  requestOrganizationId,
  type BlacklistDomainsConfig,
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

function blocklistConfig(fields: Partial<BlacklistDomainsConfig> = {}): BlacklistDomainsConfig {
  return { domains: [], updated_at: null, updated_by: null, updated_by_email: null, ...fields };
}

describe('blocklist config fields', () => {
  it('reads blocked domains and falls back when the list is empty or missing', () => {
    expect(
      blacklistedDomainsFromConfig(blocklistConfig({ domains: ['spam.com'] }), ['env.com'])
    ).toEqual(['spam.com']);
    expect(blacklistedDomainsFromConfig(blocklistConfig(), ['env.com'])).toEqual(['env.com']);
    expect(blacklistedDomainsFromConfig(null, ['env.com'])).toEqual(['env.com']);
  });

  it('reads signup TLDs and distinguishes empty from absent', () => {
    const fallback = ['shop', 'top'];
    expect(
      blockedSignupTldsFromConfig(blocklistConfig({ blocked_signup_tlds: ['asia'] }), fallback)
    ).toEqual(['asia']);
    expect(
      blockedSignupTldsFromConfig(blocklistConfig({ blocked_signup_tlds: [] }), fallback)
    ).toEqual([]);
    expect(blockedSignupTldsFromConfig(blocklistConfig(), fallback)).toEqual(fallback);
    expect(blockedSignupTldsFromConfig(null, fallback)).toEqual(fallback);
  });
});

describe('refreshBlacklistDomainsConfig', () => {
  const FULL_READ_INTERVAL_MS = 10 * 60_000;

  function fakeRedis() {
    const store: Record<string, string> = {};
    const reads: string[] = [];
    return {
      reads,
      get: async (key: string) => {
        reads.push(key);
        return store[key] ?? null;
      },
      store(config: BlacklistDomainsConfig, { writeUpdatedAtKey = true } = {}) {
        store[BLACKLISTED_DOMAINS_REDIS_KEY] = JSON.stringify(config);
        if (writeUpdatedAtKey && config.updated_at) {
          store[BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY] = config.updated_at;
        }
      },
    };
  }

  it('reads the stored config, or null when none is stored', async () => {
    const redis = fakeRedis();
    expect(await refreshBlacklistDomainsConfig(redis.get, null, 0)).toEqual({
      config: null,
      fullReadAt: 0,
    });

    const config = blocklistConfig({ domains: ['spam.com'], updated_at: 't1' });
    redis.store(config);
    expect(await refreshBlacklistDomainsConfig(redis.get, null, 0)).toEqual({
      config,
      fullReadAt: 0,
    });
  });

  it('keeps the previous snapshot without downloading the config while updated_at is unchanged', async () => {
    const redis = fakeRedis();
    redis.store(blocklistConfig({ domains: ['spam.com'], updated_at: 't1' }));
    const first = await refreshBlacklistDomainsConfig(redis.get, null, 0);
    redis.reads.length = 0;

    const second = await refreshBlacklistDomainsConfig(redis.get, first, 60_000);

    expect(second).toBe(first);
    expect(redis.reads).toEqual([BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY]);
  });

  it('downloads the config once updated_at changes', async () => {
    const redis = fakeRedis();
    redis.store(blocklistConfig({ domains: ['spam.com'], updated_at: 't1' }));
    const first = await refreshBlacklistDomainsConfig(redis.get, null, 0);
    const changed = blocklistConfig({
      domains: ['spam.com', 'junk.org'],
      blocked_signup_tlds: ['asia'],
      updated_at: 't2',
    });
    redis.store(changed);

    expect(await refreshBlacklistDomainsConfig(redis.get, first, 60_000)).toEqual({
      config: changed,
      fullReadAt: 60_000,
    });
  });

  it('downloads the config every time when the updated_at key was never written', async () => {
    const redis = fakeRedis();
    redis.store(blocklistConfig({ domains: ['spam.com'], updated_at: 't1' }), {
      writeUpdatedAtKey: false,
    });
    const first = await refreshBlacklistDomainsConfig(redis.get, null, 0);
    redis.store(blocklistConfig({ domains: ['junk.org'], updated_at: 't2' }), {
      writeUpdatedAtKey: false,
    });

    expect((await refreshBlacklistDomainsConfig(redis.get, first, 60_000)).config?.domains).toEqual(
      ['junk.org']
    );
  });

  it('downloads the config after the full-read interval even when updated_at is unchanged', async () => {
    const redis = fakeRedis();
    redis.store(blocklistConfig({ domains: ['spam.com'], updated_at: 't1' }));
    const first = await refreshBlacklistDomainsConfig(redis.get, null, 0);
    redis.store(blocklistConfig({ domains: ['junk.org'], updated_at: 't1' }));

    expect(await refreshBlacklistDomainsConfig(redis.get, first, FULL_READ_INTERVAL_MS - 1)).toBe(
      first
    );
    expect(
      (await refreshBlacklistDomainsConfig(redis.get, first, FULL_READ_INTERVAL_MS)).config?.domains
    ).toEqual(['junk.org']);
  });
});
