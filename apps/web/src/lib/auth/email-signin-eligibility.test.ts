import {
  isEmailBlacklistedByDomainAsync,
  isBlockedTLD,
} from '@kilocode/web-shared/lib/user/server';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  isEmailBlacklistedByDomainAsync: jest.fn(),
  isBlockedTLD: jest.fn(),
}));

jest.mock('@/lib/user', () => ({
  findUserByNormalizedEmail: jest.fn(),
  getWorkOSOrganization: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/organizations/organization-sso-policy', () => ({
  resolveSsoAuthorityForDomain: jest.fn(),
}));

import { findUserByNormalizedEmail } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import {
  checkDomainSignInEligibility,
  isNewAccountEligibleForMagicLink,
} from './email-signin-eligibility';

const mockIsEmailBlacklistedByDomainAsync = jest.mocked(isEmailBlacklistedByDomainAsync);
const mockIsBlockedTLD = jest.mocked(isBlockedTLD);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);

describe('checkDomainSignInEligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(false);
    mockIsBlockedTLD.mockReturnValue(false);
    mockFindUserByNormalizedEmail.mockResolvedValue(undefined);
    mockResolveSsoAuthorityForDomain.mockResolvedValue({ status: 'not_required' });
  });

  it('does not resolve SSO authority for an address without a domain', async () => {
    await expect(checkDomainSignInEligibility('no-domain')).resolves.toEqual({
      ok: true,
      existingUser: false,
    });
    expect(mockResolveSsoAuthorityForDomain).not.toHaveBeenCalled();
  });

  it('resolves SSO authority for the lowercased domain', async () => {
    await checkDomainSignInEligibility('new@Acme.Example');

    expect(mockResolveSsoAuthorityForDomain).toHaveBeenCalledWith('acme.example');
  });
});

describe('isNewAccountEligibleForMagicLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(false);
    mockIsBlockedTLD.mockReturnValue(false);
  });

  it('accepts an eligible unknown email', async () => {
    await expect(isNewAccountEligibleForMagicLink('new@example.com')).resolves.toBe(true);
  });

  it('rejects a blacklisted domain without exposing why', async () => {
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(true);

    await expect(isNewAccountEligibleForMagicLink('new@blocked.example')).resolves.toBe(false);
    expect(mockIsBlockedTLD).not.toHaveBeenCalled();
  });

  it('rejects a blocked TLD', async () => {
    mockIsBlockedTLD.mockReturnValue(true);

    await expect(isNewAccountEligibleForMagicLink('new@example.top')).resolves.toBe(false);
  });
});
