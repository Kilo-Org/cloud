import { captureMessage } from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import { getAllUserProviders, getWorkOSOrganization } from '@/lib/user';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';
import { isNewAccountEligibleForMagicLink } from '@/lib/auth/email-signin-eligibility';

jest.mock('@sentry/nextjs');
jest.mock('@/lib/auth/verify-turnstile-jwt');
jest.mock('@/lib/user');
jest.mock('@/lib/organizations/organization-sso-policy');
jest.mock('@/lib/auth/email-signin-eligibility');

import { POST } from './route';

const mockCaptureMessage = jest.mocked(captureMessage);
const mockVerifyTurnstileJWT = jest.mocked(verifyTurnstileJWT);
const mockGetAllUserProviders = jest.mocked(getAllUserProviders);
const mockGetWorkOSOrganization = jest.mocked(getWorkOSOrganization);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);
const mockIsNewAccountEligibleForMagicLink = jest.mocked(isNewAccountEligibleForMagicLink);

const request = (body: unknown) =>
  new NextRequest('http://localhost:3000/api/sso/organizations', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });

describe('POST /api/sso/organizations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyTurnstileJWT.mockResolvedValue({ success: true, token: {} } as Awaited<
      ReturnType<typeof verifyTurnstileJWT>
    >);
    mockGetAllUserProviders.mockResolvedValue({ kind: 'not_found' });
    mockIsNewAccountEligibleForMagicLink.mockResolvedValue(true);
    mockResolveSsoAuthorityForDomain.mockImplementation(async domain => ({
      status: 'not_required',
      domain,
    }));
  });

  it('requires a valid Turnstile proof before discovery', async () => {
    mockVerifyTurnstileJWT.mockResolvedValue({
      success: false,
      response: NextResponse.json({ error: 'Security verification required' }, { status: 401 }),
    });

    const response = await POST(request({ email: 'user@example.com' }));
    expect(response.status).toBe(401);
    expect(mockGetAllUserProviders).not.toHaveBeenCalled();
  });

  it('rejects invalid request email', async () => {
    const response = await POST(request({ email: 'not-an-email' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid email address.' });
  });

  it('returns one existing provider for automatic client continuation', async () => {
    mockGetAllUserProviders.mockResolvedValue({
      kind: 'found',
      user: { kiloUserId: 'user-1', providers: ['google'], primaryEmail: 'user@example.com' },
    });

    const response = await POST(request({ email: 'user@example.com' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ kind: 'existing', providers: ['google'] });
  });

  it('returns all linked providers for an existing account', async () => {
    mockGetAllUserProviders.mockResolvedValue({
      kind: 'found',
      user: {
        kiloUserId: 'user-1',
        providers: ['github', 'google', 'email'],
        primaryEmail: 'user@example.com',
      },
    });

    await expect((await POST(request({ email: 'user@example.com' }))).json()).resolves.toEqual({
      kind: 'existing',
      providers: ['github', 'google', 'email'],
    });
  });

  it('keeps Email for a normalized existing Gmail plus alias', async () => {
    mockGetAllUserProviders.mockResolvedValue({
      kind: 'found',
      user: {
        kiloUserId: 'user-1',
        providers: ['google', 'email'],
        primaryEmail: 'first.last@gmail.com',
      },
    });

    await expect(
      (await POST(request({ email: 'first.last+sign-in@gmail.com' }))).json()
    ).resolves.toEqual({ kind: 'existing', providers: ['google', 'email'] });
    expect(mockIsNewAccountEligibleForMagicLink).not.toHaveBeenCalled();
  });

  it('enforces required SSO', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'org-1',
    });
    mockGetWorkOSOrganization.mockResolvedValue({ id: 'workos-org-1' } as Awaited<
      ReturnType<typeof getWorkOSOrganization>
    >);

    await expect((await POST(request({ email: 'user@example.com' }))).json()).resolves.toEqual({
      kind: 'sso',
      organizationId: 'workos-org-1',
    });
  });

  it('returns server-authorized account-creation choices for an eligible unknown email', async () => {
    await expect((await POST(request({ email: 'new@example.com' }))).json()).resolves.toEqual({
      kind: 'new',
      providers: expect.arrayContaining(['google', 'email']),
    });
  });

  it.each(['blacklisted@example.com', 'blocked@example.top'])(
    'omits Email for an unknown address rejected by static signup eligibility: %s',
    async email => {
      mockIsNewAccountEligibleForMagicLink.mockResolvedValue(false);

      await expect((await POST(request({ email }))).json()).resolves.toEqual({
        kind: 'new',
        providers: expect.not.arrayContaining(['email']),
      });
      expect(mockIsNewAccountEligibleForMagicLink).toHaveBeenCalledWith(email);
    }
  );

  it('keeps an unknown Gmail plus alias new and ineligible for Email', async () => {
    mockIsNewAccountEligibleForMagicLink.mockResolvedValue(false);

    await expect(
      (await POST(request({ email: 'unknown+sign-in@gmail.com' }))).json()
    ).resolves.toEqual({
      kind: 'new',
      providers: expect.not.arrayContaining(['email']),
    });
    expect(mockGetAllUserProviders).toHaveBeenCalledWith('unknown+sign-in@gmail.com');
    expect(mockIsNewAccountEligibleForMagicLink).toHaveBeenCalledWith('unknown+sign-in@gmail.com');
  });

  it('fails closed for missing WorkOS configuration', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'misconfigured',
      domain: 'example.com',
      reason: 'ambiguous_domain',
    });

    expect((await POST(request({ email: 'user@example.com' }))).status).toBe(503);
  });

  it('fails closed when a required SSO domain has no WorkOS organization', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'org-1',
    });
    mockGetWorkOSOrganization.mockResolvedValue(null);

    expect((await POST(request({ email: 'user@example.com' }))).status).toBe(503);
  });

  it('fails closed before new-account eligibility when exact and normalized email sources conflict', async () => {
    mockGetAllUserProviders.mockResolvedValue({ kind: 'ambiguous' });

    const response = await POST(request({ email: 'shared@example.com' }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Unable to find sign-in methods. Please try again.',
    });
    expect(mockCaptureMessage).toHaveBeenCalledWith('Ambiguous sign-in provider lookup', {
      level: 'warning',
      tags: { source: 'sso-organizations' },
      extra: undefined,
    });
    expect(mockIsNewAccountEligibleForMagicLink).not.toHaveBeenCalled();
  });

  it('fails closed before new-account eligibility for a normalized account collision', async () => {
    mockGetAllUserProviders.mockResolvedValue({ kind: 'ambiguous' });

    expect((await POST(request({ email: 'first.last+tag@gmail.com' }))).status).toBe(503);
    expect(mockIsNewAccountEligibleForMagicLink).not.toHaveBeenCalled();
  });
});
