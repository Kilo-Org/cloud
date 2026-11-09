import { checkRateLimit } from '@vercel/firewall';
import { captureMessage } from '@sentry/nextjs';
import type { NextRequest } from 'next/server';
import { isBlockedTLD } from '@kilocode/web-shared/lib/user/server';
import { isEmailBlacklisted } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { findUserByNormalizedEmail } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  isBlockedTLD: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/blacklist-domains-config', () => ({
  isEmailBlacklisted: jest.fn(),
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
} from './email-signin-eligibility';
import { __test__ as rateLimitTest } from './firewall-rate-limit';

const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockCaptureMessage = jest.mocked(captureMessage);
const mockIsEmailBlacklisted = jest.mocked(isEmailBlacklisted);
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
    mockIsEmailBlacklisted.mockResolvedValue(false);
    mockIsBlockedTLD.mockResolvedValue(false);
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

    expect(mockIsEmailBlacklisted).toHaveBeenCalledWith('new@Acme.Example');
    expect(mockResolveSsoAuthorityForDomain).toHaveBeenCalledWith('acme.example');
  });
});

describe('isNewAccountEligibleForMagicLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailBlacklisted.mockResolvedValue(false);
    mockIsBlockedTLD.mockResolvedValue(false);
  });

  it('accepts an eligible unknown email', async () => {
    await expect(isNewAccountEligibleForMagicLink('new@example.com')).resolves.toBe(true);
  });

  it('rejects a blacklisted domain without exposing why', async () => {
    mockIsEmailBlacklisted.mockResolvedValue(true);

    await expect(isNewAccountEligibleForMagicLink('new@blocked.example')).resolves.toBe(false);
    expect(mockIsBlockedTLD).not.toHaveBeenCalled();
  });

  it('rejects a blocked TLD', async () => {
    mockIsBlockedTLD.mockResolvedValue(true);

    await expect(isNewAccountEligibleForMagicLink('new@example.top')).resolves.toBe(false);
  });

  it('rejects a malformed address before any domain lookup', async () => {
    await expect(isNewAccountEligibleForMagicLink('not-an-email')).resolves.toBe(false);
    expect(mockIsEmailBlacklisted).not.toHaveBeenCalled();
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
  const refusedSend = {
    ok: false,
    status: 429,
    errorCode: 'SIGNUP-RATE-LIMITED',
    body: { success: false, error: 'Rate limit exceeded. Please try again later.' },
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockIsEmailBlacklisted.mockResolvedValue(false);
    mockIsBlockedTLD.mockResolvedValue(false);
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

  it('refuses the send when the per-caller rule is not configured', async () => {
    mockCheckRateLimit.mockImplementation(async id => {
      if (id === 'sign-in-code-email-ip') return { rateLimited: false, error: 'not-found' };
      return { rateLimited: false };
    });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual(
      refusedSend
    );
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
  });

  it('reports an unconfigured rule once per interval while refusing every send', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual(
      refusedSend
    );
    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual(
      refusedSend
    );

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'magic-link-email' is not configured",
      { level: 'error', tags: { source: 'email_signin_eligibility' } }
    );
  });

  it('stops at the refused per-address rule without spending the caller allowance', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'not-found' });

    await checkEmailSignInEligibility('user@example.com', request());

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('magic-link-email', expect.any(Object));
  });

  it('refuses the send when the limiter cannot evaluate a rule', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'blocked' });

    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual(
      refusedSend
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "Firewall rate limit 'magic-link-email' could not be evaluated",
      { level: 'error', tags: { source: 'email_signin_eligibility' } }
    );
  });

  it('allows the send when both rules answer', async () => {
    await expect(checkEmailSignInEligibility('user@example.com', request())).resolves.toEqual({
      ok: true,
    });
  });

  it('checks caller budgets before the domain rules', async () => {
    mockIsEmailBlacklisted.mockResolvedValue(true);

    await checkEmailSignInEligibility('user@example.com', request());

    expect(mockCheckRateLimit).toHaveBeenCalled();
  });
});
