import { isEmailBlacklistedByDomainAsync, isBlockedTLD } from '@/lib/user/server';

jest.mock('@/lib/user/server', () => ({
  isEmailBlacklistedByDomainAsync: jest.fn(),
  isBlockedTLD: jest.fn(),
}));

import { isNewAccountEligibleForMagicLink } from './email-signin-eligibility';

const mockIsEmailBlacklistedByDomainAsync = jest.mocked(isEmailBlacklistedByDomainAsync);
const mockIsBlockedTLD = jest.mocked(isBlockedTLD);

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
