import { NextRequest } from 'next/server';
import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  NativeIdTokenError,
} from '@/lib/auth/native-id-tokens';
import { verifyAndConsumeSignInCode } from '@/lib/auth/magic-link-tokens';
import {
  createOrUpdateUser,
  findUserById,
  findUserByNormalizedEmail,
  findUserIdByAuthProvider,
} from '@/lib/user';
import { generateApiToken } from '@/lib/tokens';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import type { User } from '@kilocode/db/schema';

// Keep the real NativeIdTokenError class (route.ts uses `instanceof` on it) and only mock
// the verifier functions.
jest.mock('@/lib/auth/native-id-tokens', () => ({
  ...jest.requireActual('@/lib/auth/native-id-tokens'),
  verifyNativeAppleIdToken: jest.fn(),
  verifyNativeGoogleIdToken: jest.fn(),
}));
jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/user');
jest.mock('@/lib/tokens');
jest.mock('@/lib/auth/email-signin-eligibility');

import { POST } from './route';

const mockVerifyNativeAppleIdToken = jest.mocked(verifyNativeAppleIdToken);
const mockVerifyNativeGoogleIdToken = jest.mocked(verifyNativeGoogleIdToken);
const mockVerifyAndConsumeSignInCode = jest.mocked(verifyAndConsumeSignInCode);
const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockFindUserById = jest.mocked(findUserById);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockFindUserIdByAuthProvider = jest.mocked(findUserIdByAuthProvider);
const mockGenerateApiToken = jest.mocked(generateApiToken);
const mockCheckDomainSignInEligibility = jest.mocked(checkDomainSignInEligibility);

const fakeUser = { id: 'user-1', api_token_pepper: 'pepper' } as User;

describe('POST /api/auth/native/token', () => {
  const createRequest = (body: unknown) =>
    new NextRequest('http://localhost:3000/api/auth/native/token', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

  const createMalformedRequest = () =>
    new NextRequest('http://localhost:3000/api/auth/native/token', {
      method: 'POST',
      body: '{',
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateOrUpdateUser.mockResolvedValue({
      success: true,
      user: fakeUser,
      isNew: false,
    } as never);
    mockGenerateApiToken.mockReturnValue('minted-jwt');
    mockCheckDomainSignInEligibility.mockResolvedValue({ ok: true, existingUser: false });
    mockFindUserById.mockResolvedValue(undefined);
    mockFindUserByNormalizedEmail.mockResolvedValue(undefined);
    mockFindUserIdByAuthProvider.mockResolvedValue(null);
  });

  describe('apple', () => {
    it('builds args mirroring createAppleAccountInfo, autoLink=false, and mints a token', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'apple', idToken: 'apple-id-token', fullName: 'Jane Doe' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt' });
      expect(mockVerifyNativeAppleIdToken).toHaveBeenCalledWith('apple-id-token');
      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          google_user_email: 'appleuser@example.com',
          google_user_name: 'Jane Doe',
          hosted_domain: '@@apple@@',
          provider: 'apple',
          provider_account_id: 'apple-sub-1',
        }),
        undefined,
        false,
        expect.any(Headers)
      );
      expect(mockGenerateApiToken).toHaveBeenCalledWith(fakeUser);
    });

    it('falls back to the email prefix as the name when fullName is not provided', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });

      await POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }));

      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({ google_user_name: 'appleuser' }),
        undefined,
        false,
        expect.any(Headers)
      );
    });

    it('returns 401 INVALID_TOKEN when Apple verification throws NativeIdTokenError', async () => {
      mockVerifyNativeAppleIdToken.mockRejectedValue(new NativeIdTokenError('bad token'));

      const response = await POST(createRequest({ provider: 'apple', idToken: 'bad-token' }));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ error: 'INVALID_TOKEN' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('rethrows (500) instead of returning 401 when Apple verification fails with a non-token error (e.g. JWKS fetch/network failure)', async () => {
      mockVerifyNativeAppleIdToken.mockRejectedValue(new Error('network'));

      await expect(
        POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }))
      ).rejects.toThrow('network');
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 403 SSO_ERROR when the domain requires SSO, without calling createOrUpdateUser', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@sso-required.com',
      });
      mockCheckDomainSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });

      const response = await POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }));
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data).toEqual({ error: 'SSO_ERROR', ssoOrganizationId: 'workos-organization-id' });
      expect(mockCheckDomainSignInEligibility).toHaveBeenCalledWith('appleuser@sso-required.com');
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 403 BLOCKED when the domain is blacklisted, without calling createOrUpdateUser', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@blocked.com',
      });
      mockCheckDomainSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'BLOCKED',
      });

      const response = await POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }));
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data).toEqual({ error: 'BLOCKED' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('google', () => {
    it('builds args mirroring createGoogleAccountInfo (using hd) and autoLink=false', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
        name: 'Google User',
        picture: 'https://example.com/pic.png',
        hd: 'example.com',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt' });
      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          google_user_email: 'googleuser@example.com',
          google_user_name: 'Google User',
          google_user_image_url: 'https://example.com/pic.png',
          hosted_domain: 'example.com',
          provider: 'google',
          provider_account_id: 'google-sub-1',
        }),
        undefined,
        false,
        expect.any(Headers)
      );
    });

    it('falls back to non_workspace_google_account hosted_domain when hd is absent', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      await POST(createRequest({ provider: 'google', idToken: 'google-id-token' }));

      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({ hosted_domain: '@@personal@@' }),
        undefined,
        false,
        expect.any(Headers)
      );
    });

    it('returns 401 INVALID_TOKEN when Google verification throws NativeIdTokenError', async () => {
      mockVerifyNativeGoogleIdToken.mockRejectedValue(new NativeIdTokenError('bad token'));

      const response = await POST(createRequest({ provider: 'google', idToken: 'bad-token' }));
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ error: 'INVALID_TOKEN' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('rethrows (500) instead of returning 401 when Google verification fails with a non-token error (e.g. network failure)', async () => {
      mockVerifyNativeGoogleIdToken.mockRejectedValue(new Error('network'));

      await expect(
        POST(createRequest({ provider: 'google', idToken: 'google-id-token' }))
      ).rejects.toThrow('network');
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 403 SSO_ERROR when the domain requires SSO, without calling createOrUpdateUser (bypasses forced SSO otherwise)', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@sso-required.com',
      });
      mockCheckDomainSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data).toEqual({ error: 'SSO_ERROR', ssoOrganizationId: 'workos-organization-id' });
      expect(mockCheckDomainSignInEligibility).toHaveBeenCalledWith('googleuser@sso-required.com');
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 403 BLOCKED when the domain is blacklisted, without calling createOrUpdateUser', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@blocked.com',
      });
      mockCheckDomainSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'BLOCKED',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data).toEqual({ error: 'BLOCKED' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('happy path: eligible domain still succeeds with 200 { token }', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt' });
      expect(mockCreateOrUpdateUser).toHaveBeenCalled();
    });
  });

  describe('email', () => {
    it('verifies the code before createOrUpdateUser, builds args mirroring createEmailAccountInfo, autoLink=true', async () => {
      mockVerifyAndConsumeSignInCode.mockResolvedValue('ok');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt' });
      expect(mockVerifyAndConsumeSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456'
      );
      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          google_user_email: 'emailuser@example.com',
          google_user_name: 'emailuser',
          hosted_domain: 'example.com',
          provider: 'email',
          provider_account_id: 'emailuser@example.com',
        }),
        undefined,
        true,
        expect.any(Headers)
      );
      expect(mockCheckDomainSignInEligibility).toHaveBeenCalledWith('emailuser@example.com');
    });

    it('rechecks domain eligibility when redeeming an issued code', async () => {
      mockVerifyAndConsumeSignInCode.mockResolvedValue('ok');
      mockCheckDomainSignInEligibility.mockResolvedValue({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });

      const response = await POST(
        createRequest({ provider: 'email', email: 'user@sso-required.com', code: '123456' })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('lowercases the client-supplied email before building args (does not trust client casing)', async () => {
      mockVerifyAndConsumeSignInCode.mockResolvedValue('ok');

      await POST(
        createRequest({ provider: 'email', email: 'EmailUser@Example.com', code: '123456' })
      );

      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          google_user_email: 'emailuser@example.com',
          google_user_name: 'emailuser',
          hosted_domain: 'example.com',
          provider_account_id: 'emailuser@example.com',
        }),
        undefined,
        true,
        expect.any(Headers)
      );
    });

    it('returns 401 INVALID_CODE when the code is invalid, without calling createOrUpdateUser', async () => {
      mockVerifyAndConsumeSignInCode.mockResolvedValue('invalid');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '000000' })
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ error: 'INVALID_CODE' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 429 TOO_MANY_ATTEMPTS when the attempt budget is exhausted', async () => {
      mockVerifyAndConsumeSignInCode.mockResolvedValue('too_many_attempts');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '000000' })
      );
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data).toEqual({ error: 'TOO_MANY_ATTEMPTS' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });
  });

  it('returns 403 with the AuthErrorType when createOrUpdateUser fails', async () => {
    mockVerifyNativeGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'googleuser@example.com',
    });
    mockCreateOrUpdateUser.mockResolvedValue({ success: false, error: 'BLOCKED' } as never);

    const response = await POST(createRequest({ provider: 'google', idToken: 'google-id-token' }));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data).toEqual({ error: 'BLOCKED' });
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('does not mint a token for an individually blocked user', async () => {
    mockVerifyNativeGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'googleuser@example.com',
    });
    mockCreateOrUpdateUser.mockResolvedValue({
      success: true,
      user: { ...fakeUser, blocked_reason: 'manual block' },
      isNew: false,
    } as never);

    const response = await POST(createRequest({ provider: 'google', idToken: 'google-id-token' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'BLOCKED' });
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('checks the resolved account email before minting a token', async () => {
    mockVerifyNativeGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'personal@gmail.com',
    });
    mockCreateOrUpdateUser.mockResolvedValue({
      success: true,
      user: { ...fakeUser, google_user_email: 'user@sso-required.com' },
      isNew: false,
    } as never);
    mockCheckDomainSignInEligibility
      .mockResolvedValueOnce({ ok: true, existingUser: false })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });

    const response = await POST(createRequest({ provider: 'google', idToken: 'google-id-token' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'SSO_ERROR',
      ssoOrganizationId: 'workos-organization-id',
    });
    expect(mockCheckDomainSignInEligibility).toHaveBeenLastCalledWith('user@sso-required.com');
    expect(mockGenerateApiToken).not.toHaveBeenCalled();
  });

  it('checks a linked provider account primary email before user sync', async () => {
    mockVerifyNativeGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'personal@gmail.com',
    });
    mockFindUserIdByAuthProvider.mockResolvedValue('user-1');
    mockFindUserById.mockResolvedValue({
      ...fakeUser,
      google_user_email: 'user@sso-required.com',
      blocked_reason: null,
    });
    mockCheckDomainSignInEligibility
      .mockResolvedValueOnce({ ok: true, existingUser: false })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        errorCode: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });

    const response = await POST(createRequest({ provider: 'google', idToken: 'google-id-token' }));

    expect(response.status).toBe(403);
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body (unknown provider)', async () => {
    const response = await POST(createRequest({ provider: 'bogus' }));

    expect(response.status).toBe(400);
    expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 400 when required fields are missing', async () => {
    const response = await POST(createRequest({ provider: 'email', email: 'no-code@example.com' }));

    expect(response.status).toBe(400);
  });

  it('returns 400 when the request body is malformed JSON', async () => {
    const response = await POST(createMalformedRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
  });
});
