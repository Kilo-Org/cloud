import { verifyTurnstileJWT } from '@/lib/auth/verify-turnstile-jwt';
import {
  createMagicLinkToken,
  type MagicLinkTokenWithPlaintext,
} from '@/lib/auth/magic-link-tokens';
import { sendMagicLinkEmail } from '@/lib/email';
import { findUserByNormalizedEmail, getWorkOSOrganization } from '@/lib/user';
import { MAGIC_LINK_EMAIL_ERRORS } from '@/lib/schemas/email';
import { checkRateLimit } from '@vercel/firewall';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { resolveSsoAuthorityForDomain } from '@/lib/organizations/organization-sso-policy';

jest.mock('@vercel/firewall');
jest.mock('@/lib/auth/verify-turnstile-jwt');
jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/email');
jest.mock('@/lib/user');
jest.mock('@/lib/organizations/organization-sso-policy');

import { POST } from './route';

const mockVerifyTurnstileJWT = jest.mocked(verifyTurnstileJWT);
const mockCreateMagicLinkToken = jest.mocked(createMagicLinkToken);
const mockSendMagicLinkEmail = jest.mocked(sendMagicLinkEmail);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockGetWorkOSOrganization = jest.mocked(getWorkOSOrganization);
const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockResolveSsoAuthorityForDomain = jest.mocked(resolveSsoAuthorityForDomain);

describe('POST /api/auth/magic-link', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  const mockMagicLinkToken: MagicLinkTokenWithPlaintext = {
    token_hash: 'hash123',
    email: 'user@example.com',
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    consumed_at: null,
    created_at: new Date().toISOString(),
    purpose: 'magic_link',
    plaintext_token: 'plaintext123',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: Turnstile verification succeeds
    mockVerifyTurnstileJWT.mockResolvedValue({
      success: true,
      token: {
        ip: '192.168.1.1',
        guid: '00000000-0000-0000-0000-000000000000',
        iat: 1234567890,
        exp: 1234567890 + 3600,
      },
    });

    // Default: Magic link creation succeeds
    mockCreateMagicLinkToken.mockResolvedValue(mockMagicLinkToken);
    mockSendMagicLinkEmail.mockResolvedValue({ sent: true });

    // Default: User does not exist (new user signup)
    mockFindUserByNormalizedEmail.mockResolvedValue(undefined);

    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockResolveSsoAuthorityForDomain.mockImplementation(async domain => ({
      status: 'not_required',
      domain,
    }));
    mockGetWorkOSOrganization.mockResolvedValue({ id: 'workos-organization-id' } as Awaited<
      ReturnType<typeof getWorkOSOrganization>
    >);
  });

  it('should send magic link for valid email with valid JWT', async () => {
    const request = createRequest({ email: 'user@example.com' });
    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({
      success: true,
      message: 'Magic link sent to your email',
    });

    expect(mockVerifyTurnstileJWT).toHaveBeenCalledWith('magic-link');
    expect(mockCheckRateLimit).toHaveBeenCalledWith('magic-link-email', {
      request,
      rateLimitKey: expect.stringMatching(/^magic-link-email:[A-Za-z0-9_-]+$/),
    });
    expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user@example.com');
    expect(mockSendMagicLinkEmail).toHaveBeenCalledWith(mockMagicLinkToken, undefined);
  });

  it('rejects magic links for an SSO-protected domain before creating a token', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'sso-organization-id',
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Sign in with your organization SSO provider.',
      ssoOrganizationId: 'workos-organization-id',
    });
    expect(mockGetWorkOSOrganization).toHaveBeenCalledWith('example.com');
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('fails closed when WorkOS is missing for an SSO-protected domain', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'example.com',
      sourceOrganizationId: 'sso-organization-id',
    });
    mockGetWorkOSOrganization.mockResolvedValue(null);

    const response = await POST(createRequest({ email: 'user@example.com' }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'SSO configuration error. Contact your administrator.',
    });
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('uses an existing account primary domain for SSO enforcement', async () => {
    mockFindUserByNormalizedEmail.mockResolvedValue({
      id: 'existing-user-id',
      google_user_email: 'user@company.com',
    } as Awaited<ReturnType<typeof findUserByNormalizedEmail>>);
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'required',
      domain: 'company.com',
      sourceOrganizationId: 'sso-organization-id',
    });

    const response = await POST(createRequest({ email: 'user@personal.example' }));

    expect(response.status).toBe(403);
    expect(mockResolveSsoAuthorityForDomain).toHaveBeenCalledWith('company.com');
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
  });

  it('fails closed when the SSO authority is misconfigured', async () => {
    mockResolveSsoAuthorityForDomain.mockResolvedValue({
      status: 'misconfigured',
      domain: 'example.com',
      reason: 'ambiguous_domain',
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));

    expect(response.status).toBe(503);
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
  });

  it('should return 429 when the email address is rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data).toEqual({
      success: false,
      error: 'Rate limit exceeded. Please try again later.',
    });
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('should use the same rate limit key for different email casing', async () => {
    mockFindUserByNormalizedEmail.mockResolvedValue({
      id: 'existing-user-id',
      google_user_email: 'user@example.com',
    } as Awaited<ReturnType<typeof findUserByNormalizedEmail>>);

    await POST(createRequest({ email: 'User@Example.com' }));
    await POST(createRequest({ email: 'user@example.com' }));

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    const firstKey = mockCheckRateLimit.mock.calls[0]?.[1]?.rateLimitKey;
    const secondKey = mockCheckRateLimit.mock.calls[1]?.[1]?.rateLimitKey;
    expect(firstKey).toEqual(expect.stringMatching(/^magic-link-email:[A-Za-z0-9_-]+$/));
    expect(secondKey).toBe(firstKey);
  });

  it('uses the same rate limit key for aliases of the same mailbox', async () => {
    await POST(createRequest({ email: 'te.st+first@gmail.com' }));
    await POST(createRequest({ email: 'test+second@googlemail.com' }));

    const firstKey = mockCheckRateLimit.mock.calls[0]?.[1]?.rateLimitKey;
    const secondKey = mockCheckRateLimit.mock.calls[1]?.[1]?.rateLimitKey;
    expect(secondKey).toBe(firstKey);
  });

  it('should reject request with invalid Turnstile JWT', async () => {
    const errorResponse = NextResponse.json(
      { error: 'Security verification required' },
      { status: 401 }
    );

    mockVerifyTurnstileJWT.mockResolvedValue({
      success: false,
      response: errorResponse,
    });

    const response = await POST(createRequest({ email: 'user@example.com' }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Security verification required' });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    expect(mockSendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it('should reject request with invalid email format', async () => {
    const response = await POST(createRequest({ email: 'not-an-email' }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  it('should reject request with missing email', async () => {
    const response = await POST(createRequest({}));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  it('should validate email format before checking Turnstile', async () => {
    // This test verifies the current behavior: email validation happens first
    // This is correct - we should fail fast on invalid request format
    const errorResponse = NextResponse.json(
      { error: 'Security verification required' },
      { status: 401 }
    );

    mockVerifyTurnstileJWT.mockResolvedValue({
      success: false,
      response: errorResponse,
    });

    const response = await POST(createRequest({ email: 'not-an-email' }));
    const data = await response.json();

    // Email validation fails first with 400, Turnstile check never runs
    expect(response.status).toBe(400);
    expect(data).toEqual({ success: false, error: 'Invalid request data' });
    expect(mockVerifyTurnstileJWT).not.toHaveBeenCalled();
  });

  describe('magic link signup email validation', () => {
    it('should reject uppercase email for new users', async () => {
      mockFindUserByNormalizedEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'User@Example.com' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ success: false, error: MAGIC_LINK_EMAIL_ERRORS.LOWERCASE });
      expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    });

    it('should reject email with + for new users', async () => {
      mockFindUserByNormalizedEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'user+tag@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ success: false, error: MAGIC_LINK_EMAIL_ERRORS.NO_PLUS });
      expect(mockCreateMagicLinkToken).not.toHaveBeenCalled();
    });

    it('should allow uppercase email for existing users (sign-in)', async () => {
      mockFindUserByNormalizedEmail.mockResolvedValue({
        id: 'existing-user-id',
        google_user_email: 'User@Example.com',
      } as Awaited<ReturnType<typeof findUserByNormalizedEmail>>);

      const response = await POST(createRequest({ email: 'User@Example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('User@Example.com');
    });

    it('should allow email with + for existing users (sign-in)', async () => {
      mockFindUserByNormalizedEmail.mockResolvedValue({
        id: 'existing-user-id',
        google_user_email: 'user+tag@example.com',
      } as Awaited<ReturnType<typeof findUserByNormalizedEmail>>);

      const response = await POST(createRequest({ email: 'user+tag@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user+tag@example.com');
    });

    it('should allow valid lowercase email without + for new users', async () => {
      mockFindUserByNormalizedEmail.mockResolvedValue(undefined); // New user

      const response = await POST(createRequest({ email: 'user@example.com' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockCreateMagicLinkToken).toHaveBeenCalledWith('user@example.com');
    });
  });
});
