import { checkRateLimit } from '@vercel/firewall';
import type { NextRequest } from 'next/server';
import {
  isEmailBlacklistedByDomainAsync,
  isBlockedTLD,
} from '@kilocode/web-shared/lib/user/server';
import { findUserByNormalizedEmail, getWorkOSOrganization } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
}));
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

import {
  isNewAccountEligibleForMagicLink,
  checkEmailSignInEligibility,
} from './email-signin-eligibility';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockIsEmailBlacklistedByDomainAsync = jest.mocked(isEmailBlacklistedByDomainAsync);
const mockIsBlockedTLD = jest.mocked(isBlockedTLD);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);

const request = (ip?: string) =>
  ({
    headers: new Headers(
      ip
        ? {
            'x-forwarded-for': ip,
          }
        : {}
    ),
    url: 'http://localhost:3000/api/auth/native/otp',
  }) as unknown as NextRequest;

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

describe('checkEmailSignInEligibility send budgets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(false);
    mockIsBlockedTLD.mockReturnValue(false);
    mockFindUserByNormalizedEmail.mockResolvedValue(undefined);
    mockResolveSsoAuthorityForDomain.mockImplementation(async domain => ({
      status: 'not_required',
      domain,
    }));
  });

  it('counts a send against the per-address rule first, then the caller and total rules', async () => {
    await checkEmailSignInEligibility('user@example.com', request('203.0.113.7'));

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(3);
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(1, 'magic-link-email', {
      request: request('203.0.113.7'),
      rateLimitKey: expect.stringMatching(/^magic-link-email:[A-Za-z0-9_-]+$/),
    });
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'sign-in-code-email-ip', {
      request: request('203.0.113.7'),
      rateLimitKey: 'sign-in-code-email-ip:203.0.113.7',
    });
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(3, 'sign-in-code-email-global', {
      request: request('203.0.113.7'),
      rateLimitKey: 'sign-in-code-email-global:total',
    });
  });

  it('keys the per-caller rule on the first forwarded hop and falls back to the real address', async () => {
    await checkEmailSignInEligibility('user@example.com', request('203.0.113.7, 70.41.3.18'));

    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'sign-in-code-email-ip', {
      request: request('203.0.113.7, 70.41.3.18'),
      rateLimitKey: 'sign-in-code-email-ip:203.0.113.7',
    });
  });

  it('returns 429 SIGNUP-RATE-LIMITED when the per-caller rule is exhausted', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-ip') return { rateLimited: true };
      return { rateLimited: false };
    });

    await expect(
      checkEmailSignInEligibility('user@example.com', request('203.0.113.7'))
    ).resolves.toEqual({
      ok: false,
      status: 429,
      errorCode: 'SIGNUP-RATE-LIMITED',
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    });
  });

  it('returns 429 when the total rule is exhausted even with an unused per-address allowance', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-global') return { rateLimited: true };
      return { rateLimited: false };
    });

    await expect(
      checkEmailSignInEligibility('user@example.com', request('203.0.113.7'))
    ).resolves.toEqual({
      ok: false,
      status: 429,
      errorCode: 'SIGNUP-RATE-LIMITED',
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    });
  });

  it('returns 503 SIGNUP-UNAVAILABLE when a rule is missing from the firewall configuration', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-global') return { rateLimited: false, error: 'not-found' };
      return { rateLimited: false };
    });

    await expect(
      checkEmailSignInEligibility('user@example.com', request('203.0.113.7'))
    ).resolves.toEqual({
      ok: false,
      status: 503,
      errorCode: 'SIGNUP-UNAVAILABLE',
      body: {
        success: false,
        error: 'Sign-in is temporarily unavailable. Please try again later.',
      },
    });
  });

  it('returns 503 when the per-address rule is missing, before any send', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'magic-link-email') return { rateLimited: false, error: 'not-found' };
      return { rateLimited: false };
    });

    await expect(
      checkEmailSignInEligibility('user@example.com', request('203.0.113.7'))
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 503, errorCode: 'SIGNUP-UNAVAILABLE' })
    );
  });

  it('checks budgets before the domain rules', async () => {
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(true);

    await checkEmailSignInEligibility('user@example.com', request('203.0.113.7'));

    expect(mockCheckRateLimit).toHaveBeenCalled();
  });
});
