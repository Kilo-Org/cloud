import { NextRequest } from 'next/server';
import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  NativeIdTokenError,
} from '@/lib/auth/native-id-tokens';
import {
  reserveSignInCode,
  commitSignInCode,
  releaseSignInCode,
  consumeSignInCode,
} from '@/lib/auth/magic-link-tokens';
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
jest.mock('@/lib/auth/native-admission');
jest.mock('@/lib/auth/device-sessions');
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

import { POST } from './route';
import { checkNativeAdmission } from '@/lib/auth/native-admission';
import { createDeviceSession, issueSessionCredentials } from '@/lib/auth/device-sessions';
import { captureMessage } from '@sentry/nextjs';

const mockVerifyNativeAppleIdToken = jest.mocked(verifyNativeAppleIdToken);
const mockVerifyNativeGoogleIdToken = jest.mocked(verifyNativeGoogleIdToken);
const mockReserveSignInCode = jest.mocked(reserveSignInCode);
const mockCommitSignInCode = jest.mocked(commitSignInCode);
const mockReleaseSignInCode = jest.mocked(releaseSignInCode);
const mockConsumeSignInCode = jest.mocked(consumeSignInCode);
const mockCreateOrUpdateUser = jest.mocked(createOrUpdateUser);
const mockFindUserById = jest.mocked(findUserById);
const mockFindUserByNormalizedEmail = jest.mocked(findUserByNormalizedEmail);
const mockFindUserIdByAuthProvider = jest.mocked(findUserIdByAuthProvider);
const mockGenerateApiToken = jest.mocked(generateApiToken);
const mockCheckDomainSignInEligibility = jest.mocked(checkDomainSignInEligibility);
const mockCheckNativeAdmission = jest.mocked(checkNativeAdmission);
const mockCreateDeviceSession = jest.mocked(createDeviceSession);
const mockIssueSessionCredentials = jest.mocked(issueSessionCredentials);
const mockCaptureMessage = jest.mocked(captureMessage);

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
    mockCheckNativeAdmission.mockReturnValue({ ok: true });
    mockReserveSignInCode.mockResolvedValue('ok');
    mockCommitSignInCode.mockResolvedValue(true);
    mockReleaseSignInCode.mockResolvedValue(undefined);
    mockConsumeSignInCode.mockResolvedValue(true);
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
    it('reserves, settles, commits, and mints a token', async () => {
      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt' });
      expect(mockReserveSignInCode).toHaveBeenCalledWith('emailuser@example.com', '123456');
      expect(mockCommitSignInCode).toHaveBeenCalledWith('emailuser@example.com', '123456');
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
      expect(mockReleaseSignInCode).not.toHaveBeenCalled();
      expect(mockConsumeSignInCode).not.toHaveBeenCalled();
    });

    it('rechecks domain eligibility when redeeming an issued code', async () => {
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
      expect(mockReleaseSignInCode).toHaveBeenCalled();
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('lowercases the client-supplied email before building args (does not trust client casing)', async () => {
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
      mockReserveSignInCode.mockResolvedValue('invalid');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '000000' })
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ error: 'INVALID_CODE' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 429 TOO_MANY_ATTEMPTS when the attempt budget is exhausted', async () => {
      mockReserveSignInCode.mockResolvedValue('too_many_attempts');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '000000' })
      );
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data).toEqual({ error: 'TOO_MANY_ATTEMPTS' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 425 CODE_IN_PROGRESS when another request holds the reservation', async () => {
      mockReserveSignInCode.mockResolvedValue('in_progress');

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );
      const data = await response.json();

      expect(response.status).toBe(425);
      expect(data).toEqual({ error: 'CODE_IN_PROGRESS' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('releases the reservation when createOrUpdateUser fails', async () => {
      mockCreateOrUpdateUser.mockResolvedValue({ success: false, error: 'BLOCKED' } as never);

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );

      expect(response.status).toBe(403);
      expect(mockReleaseSignInCode).toHaveBeenCalled();
    });

    it('releases the code on DIFFERENT-OAUTH settlement failure so retry succeeds', async () => {
      mockCreateOrUpdateUser.mockResolvedValue({
        success: false,
        error: 'DIFFERENT-OAUTH',
      } as never);

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'different-oauth@example.com',
          code: '123456',
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'DIFFERENT-OAUTH' });
      expect(mockReleaseSignInCode).toHaveBeenCalled();
      // The code was released, not consumed — no commit or consume occurred.
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockConsumeSignInCode).not.toHaveBeenCalled();
    });

    it('retry after DIFFERENT-OAUTH release reserves and settles the same code', async () => {
      // First call: DIFFERENT-OAUTH triggers release. The second call must
      // re-reserve the same code and settle successfully, proving the release.
      mockCreateOrUpdateUser
        .mockResolvedValueOnce({
          success: false,
          error: 'DIFFERENT-OAUTH',
        } as never)
        // Second call falls back to the beforeEach success default.
        .mockResolvedValueOnce({
          success: true,
          user: fakeUser,
          isNew: false,
        } as never);

      const email = 'retry-oauth@example.com';
      const code = '654321';

      // First attempt: DIFFERENT-OAUTH → release.
      const first = await POST(createRequest({ provider: 'email', email, code }));
      expect(first.status).toBe(403);
      expect(await first.json()).toEqual({ error: 'DIFFERENT-OAUTH' });
      expect(mockReleaseSignInCode).toHaveBeenCalledWith(email, code);
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockConsumeSignInCode).not.toHaveBeenCalled();

      // Second attempt: code was released, re-reserve succeeds, settle works.
      const second = await POST(createRequest({ provider: 'email', email, code }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ token: 'minted-jwt' });

      // One account minted across both attempts.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(2);
      expect(mockGenerateApiToken).toHaveBeenCalledTimes(1);
      expect(mockCommitSignInCode).toHaveBeenCalledTimes(1);
      expect(mockCommitSignInCode).toHaveBeenCalledWith(email, code);
      // releaseSignInCode was only called once (on the first failure).
      expect(mockReleaseSignInCode).toHaveBeenCalledTimes(1);
    });

    it('releases the reservation on an unexpected error', async () => {
      mockCreateOrUpdateUser.mockRejectedValue(new Error('DB crash'));

      await expect(
        POST(createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' }))
      ).rejects.toThrow('DB crash');
      expect(mockReleaseSignInCode).toHaveBeenCalled();
    });

    it('unconditionally consumes the code when the reservation lapsed mid-settlement', async () => {
      mockCommitSignInCode.mockResolvedValue(false);

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );

      expect(response.status).toBe(200);
      expect(mockConsumeSignInCode).toHaveBeenCalledWith('emailuser@example.com', '123456');
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_token_code_reservation_lapsed');
    });

    it('returns 401 INVALID_CODE when lapse-consume fails (another request already consumed the code)', async () => {
      mockCommitSignInCode.mockResolvedValue(false);
      mockConsumeSignInCode.mockResolvedValue(false);

      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'INVALID_CODE' });
      // No credentials must be issued when consumeSignInCode fails.
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
      expect(mockCreateDeviceSession).not.toHaveBeenCalled();
      expect(mockReleaseSignInCode).not.toHaveBeenCalled();
    });

    it('reservation-lapse full-flow produces one account and one device session', async () => {
      mockCommitSignInCode.mockResolvedValue(false);
      mockConsumeSignInCode.mockResolvedValue(true);
      mockCreateDeviceSession.mockResolvedValue('session-lapse-1');
      mockIssueSessionCredentials.mockResolvedValue({
        token: 'short-jwt',
        refreshToken: 'refresh-xyz',
        expiresIn: 3600,
      });

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'lapse@example.com',
          code: '123456',
          supportsRefresh: true,
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        token: 'short-jwt',
        refreshToken: 'refresh-xyz',
        expiresIn: 3600,
      });

      // One account, one session, no legacy token.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(1);
      expect(mockCreateDeviceSession).toHaveBeenCalledTimes(1);
      expect(mockIssueSessionCredentials).toHaveBeenCalledTimes(1);
      expect(mockConsumeSignInCode).toHaveBeenCalledWith('lapse@example.com', '123456');
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_token_code_reservation_lapsed');
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
      expect(mockReleaseSignInCode).not.toHaveBeenCalled();
    });

    it('concurrent submissions produce exactly one settlement and one credential', async () => {
      // First call gets the reservation; second gets IN_PROGRESS.
      mockReserveSignInCode.mockResolvedValueOnce('ok').mockResolvedValueOnce('in_progress');
      mockCommitSignInCode.mockResolvedValue(true);

      const req = (code: string) =>
        createRequest({
          provider: 'email',
          email: 'concurrent@example.com',
          code,
        });

      const [resA, resB] = await Promise.all([POST(req('654321')), POST(req('654321'))]);

      const [statusA, statusB] = [resA.status, resB.status].toSorted();
      expect([statusA, statusB]).toEqual([200, 425]);

      // Only one createOrUpdateUser and one credential.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(1);
      expect(mockGenerateApiToken).toHaveBeenCalledTimes(1);
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

  describe('admission', () => {
    it('returns 403 ADMISSION_REQUIRED when admission check fails', async () => {
      mockCheckNativeAdmission.mockReturnValue({
        ok: false,
        errorCode: 'ADMISSION_REQUIRED',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      // Must not proceed to provider verification.
      expect(mockVerifyNativeGoogleIdToken).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('runs admission check before provider verification', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );
      expect(response.status).toBe(200);
      expect(mockCheckNativeAdmission).toHaveBeenCalled();
      expect(mockVerifyNativeGoogleIdToken).toHaveBeenCalled();
    });
  });

  describe('supportsRefresh', () => {
    it('returns short-lived pair when supportsRefresh is true', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateDeviceSession.mockResolvedValue('session-1');
      mockIssueSessionCredentials.mockResolvedValue({
        token: 'short-jwt',
        refreshToken: 'refresh-abc',
        expiresIn: 3600,
      });

      const response = await POST(
        createRequest({
          provider: 'google',
          idToken: 'google-id-token',
          supportsRefresh: true,
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        token: 'short-jwt',
        refreshToken: 'refresh-abc',
        expiresIn: 3600,
      });
      expect(mockCreateDeviceSession).toHaveBeenCalledWith({
        userId: fakeUser.id,
        userAgent: undefined, // NextRequest has no user-agent header by default
      });
      expect(mockIssueSessionCredentials).toHaveBeenCalledWith(fakeUser, 'session-1');
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it('returns long-lived token when supportsRefresh is absent', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt' });
      expect(mockGenerateApiToken).toHaveBeenCalledWith(fakeUser);
      expect(mockCreateDeviceSession).not.toHaveBeenCalled();
      expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_token_legacy_long_lived_count: 1');
    });

    it('returns long-lived token when supportsRefresh is false', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      const response = await POST(
        createRequest({
          provider: 'google',
          idToken: 'google-id-token',
          supportsRefresh: false,
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt' });
      expect(mockCreateDeviceSession).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_token_legacy_long_lived_count: 1');
    });
  });
});
