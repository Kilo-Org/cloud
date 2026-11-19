import { blacklisted_domains_settings } from '@kilocode/db/schema';
import { isEmailBlacklisted } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import { findUserByNormalizedEmail } from '@/lib/user';
import { checkDomainSignInEligibility } from './email-signin-eligibility';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/blacklist-domains-config'),
  isEmailBlacklisted: jest.fn(),
}));
jest.mock('@/lib/user', () => ({
  findUserByNormalizedEmail: jest.fn(),
  getWorkOSOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  resolveSsoAuthorityForDomain: jest.fn(),
}));

const mockFindUser = jest.mocked(findUserByNormalizedEmail);
const mockResolveSso = jest.mocked(resolveSsoAuthorityForDomain);

describe('checkDomainSignInEligibility with Postgres signup TLD settings', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.clearAllMocks();
    jest.mocked(isEmailBlacklisted).mockResolvedValue(false);
    mockFindUser.mockResolvedValue(undefined);
    mockResolveSso.mockImplementation(async domain => ({ status: 'not_required', domain }));
    jest.mocked(redisClient.get).mockImplementation(async <T>(key: string) =>
      key === BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY
        ? (JSON.stringify({
            blocked_signup_tlds: ['shop', 'top'],
            updated_at: null,
            updated_by: null,
            updated_by_email: null,
          }) as T)
        : null
    );
  });

  async function insertSettings(blocked_signup_tlds: string[]): Promise<void> {
    await db.insert(blacklisted_domains_settings).values({
      blocked_signup_tlds,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  }

  it('uses Postgres rather than conflicting Redis settings for new users', async () => {
    await insertSettings(['asia']);

    await expect(checkDomainSignInEligibility('new@example.asia')).resolves.toEqual({
      ok: false,
      status: 403,
      errorCode: 'BLOCKED',
    });
    await expect(checkDomainSignInEligibility('new@example.shop')).resolves.toEqual({
      ok: true,
      existingUser: false,
    });
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  it('allows an existing user on a Postgres-blocked TLD', async () => {
    await insertSettings(['asia']);
    const email = 'user@example.asia';

    await expect(checkDomainSignInEligibility(email)).resolves.toEqual({
      ok: false,
      status: 403,
      errorCode: 'BLOCKED',
    });
    mockFindUser.mockResolvedValue({
      id: 'existing-user',
      google_user_email: email,
    } as Awaited<ReturnType<typeof findUserByNormalizedEmail>>);
    await expect(checkDomainSignInEligibility(email)).resolves.toEqual({
      ok: true,
      existingUser: true,
    });
    expect(mockResolveSso).toHaveBeenCalledWith('example.asia');
    expect(redisClient.get).not.toHaveBeenCalled();
  });

  it('honors an explicit empty Postgres list for new users', async () => {
    await insertSettings([]);

    await expect(checkDomainSignInEligibility('new@example.shop')).resolves.toEqual({
      ok: true,
      existingUser: false,
    });
    await expect(checkDomainSignInEligibility('new@example.top')).resolves.toEqual({
      ok: true,
      existingUser: false,
    });
    expect(redisClient.get).not.toHaveBeenCalled();
  });
});
