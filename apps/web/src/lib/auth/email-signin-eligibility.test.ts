import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import type { NextRequest } from 'next/server';
import {
  isEmailBlacklistedByDomainAsync,
  isBlockedTLD,
} from '@kilocode/web-shared/lib/user/server';
import { findUserByNormalizedEmail } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
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
  checkDomainSignInEligibility,
  isNewAccountEligibleForMagicLink,
  checkEmailSignInEligibility,
  checkGlobalSendBudget,
} from './email-signin-eligibility';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const mockIsEmailBlacklistedByDomainAsync = jest.mocked(isEmailBlacklistedByDomainAsync);
const mockIsBlockedTLD = jest.mocked(isBlockedTLD);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);

const request = (headers: Record<string, string> = {}) =>
  ({
    headers: new Headers(headers),
    url: 'http://localhost:3000/api/auth/native/otp',
  }) as unknown as NextRequest;

describe('checkDomainSignInEligibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(false);
    mockIsBlockedTLD.mockReturnValue(false);
    mockFindUserByNormalizedEmail.mockResolvedValue(undefined);
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'not_required',
      domain: 'example.com',
    });
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

  it('rejects a malformed address before any domain lookup', async () => {
    await expect(isNewAccountEligibleForMagicLink('not-an-email')).resolves.toBe(false);
    expect(mockIsEmailBlacklistedByDomainAsync).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'false', 'TRUE'])(
    'rejects every new address unless EMAIL_SIGNUPS_ENABLED is exactly true: %s',
    async value => {
      if (value === undefined) delete process.env.EMAIL_SIGNUPS_ENABLED;
      else process.env.EMAIL_SIGNUPS_ENABLED = value;
      try {
        await expect(isNewAccountEligibleForMagicLink('new@example.com')).resolves.toBe(false);
      } finally {
        process.env.EMAIL_SIGNUPS_ENABLED = 'true';
      }
    }
  );
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

  it('counts a send against the per-address rule first, then the caller rule', async () => {
    await checkEmailSignInEligibility('user@example.com', request());

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(1, 'magic-link-email', {
      request: request(),
      rateLimitKey: expect.stringMatching(/^magic-link-email:[A-Za-z0-9_-]+$/),
    });
    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'sign-in-code-email-ip', {
      request: request(),
      rateLimitKey: 'sign-in-code-email-ip:unknown',
    });
  });

  it('keys the per-caller rule on the edge-provided forwarded header', async () => {
    await checkEmailSignInEligibility(
      'user@example.com',
      request({ 'x-vercel-forwarded-for': '203.0.113.7, 70.41.3.18' })
    );

    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'sign-in-code-email-ip', {
      request: request({ 'x-vercel-forwarded-for': '203.0.113.7, 70.41.3.18' }),
      rateLimitKey: 'sign-in-code-email-ip:203.0.113.7',
    });
  });

  it('falls back to the real address when the forwarded header is absent', async () => {
    await checkEmailSignInEligibility('user@example.com', request({ 'x-real-ip': '198.51.100.4' }));

    expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'sign-in-code-email-ip', {
      request: request({ 'x-real-ip': '198.51.100.4' }),
      rateLimitKey: 'sign-in-code-email-ip:198.51.100.4',
    });
  });

  it('returns 429 SIGNUP-RATE-LIMITED when the per-caller rule is exhausted', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-ip') return { rateLimited: true };
      return { rateLimited: false };
    });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual({
      ok: false,
      status: 429,
      errorCode: 'SIGNUP-RATE-LIMITED',
      body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
    });
  });

  it('returns 503 SIGNUP-UNAVAILABLE when a caller rule is missing from the firewall configuration', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-ip') return { rateLimited: false, error: 'not-found' };
      return { rateLimited: false };
    });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual({
      ok: false,
      status: 503,
      errorCode: 'SIGNUP-UNAVAILABLE',
      body: {
        success: false,
        error: 'Sign-in is temporarily unavailable. Please try again later.',
      },
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'sign-in-code-email-ip' is not configured",
      expect.objectContaining({ level: 'error' })
    );
  });

  it('returns 503 when the per-address rule is missing, before any send', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'magic-link-email') return { rateLimited: false, error: 'not-found' };
      return { rateLimited: false };
    });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual(
      expect.objectContaining({ ok: false, status: 503, errorCode: 'SIGNUP-UNAVAILABLE' })
    );
  });

  it('checks caller budgets before the domain rules', async () => {
    mockIsEmailBlacklistedByDomainAsync.mockResolvedValue(true);

    await checkEmailSignInEligibility('user@example.com', request());

    expect(mockCheckRateLimit).toHaveBeenCalled();
  });
});

describe('checkGlobalSendBudget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
  });

  it('counts the shared total bucket', async () => {
    await checkGlobalSendBudget(request());

    expect(mockCheckRateLimit).toHaveBeenCalledWith('sign-in-code-email-global', {
      request: request(),
      rateLimitKey: 'sign-in-code-email-global:total',
    });
  });

  it('returns 429 when the total bucket is exhausted', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(checkGlobalSendBudget(request())).resolves.toEqual({
      ok: false,
      status: 429,
      errorCode: 'SIGNUP-RATE-LIMITED',
    });
  });

  it('returns 503 and reports when the rule is missing from the firewall configuration', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await expect(checkGlobalSendBudget(request())).resolves.toEqual({
      ok: false,
      status: 503,
      errorCode: 'SIGNUP-UNAVAILABLE',
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'sign-in-code-email-global' is not configured",
      expect.objectContaining({ level: 'error' })
    );
  });
});
