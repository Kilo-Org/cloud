import { NextRequest } from 'next/server';
import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  exchangeNativeGoogleAuthCode,
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
  exchangeNativeGoogleAuthCode: jest.fn(),
}));
jest.mock('@/lib/auth/magic-link-tokens');
jest.mock('@/lib/user');
jest.mock('@/lib/tokens');
jest.mock('@/lib/auth/email-signin-eligibility');
jest.mock('@/lib/auth/native-admission', () => ({
  ...jest.requireActual('@/lib/auth/native-admission'),
  checkNativeAdmission: jest.fn(),
  validateAdmissionPayload: jest.fn(),
  verifyAdmissionAsync: jest.fn(),
  persistAttestedKey: jest.fn(),
  shouldRefuseAsyncFailure: jest.fn(),
}));
jest.mock('@/lib/auth/device-sessions');
jest.mock('@/lib/config.server', () => ({
  GOOGLE_CLIENT_ID: 'web-client-id',
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

// eslint-disable-next-line no-var
var mockPosthogCapture: jest.Mock;
jest.mock('@/lib/posthog', () => {
  const capture = jest.fn();
  mockPosthogCapture = capture;
  return {
    __esModule: true,
    default: jest.fn(() => ({
      capture,
      isFeatureEnabled: jest.fn(),
      getFeatureFlag: jest.fn(),
      debug: jest.fn(),
      alias: jest.fn(),
    })),
  };
});

import { POST } from './route';
import {
  checkNativeAdmission,
  validateAdmissionPayload,
  verifyAdmissionAsync,
  persistAttestedKey,
  shouldRefuseAsyncFailure,
  KeyCollisionError,
} from '@/lib/auth/native-admission';
import {
  createDeviceSession,
  issueSessionCredentials,
  createDeviceSessionWithAttestedKey,
} from '@/lib/auth/device-sessions';
import { captureMessage } from '@sentry/nextjs';

const mockVerifyNativeAppleIdToken = jest.mocked(verifyNativeAppleIdToken);
const mockVerifyNativeGoogleIdToken = jest.mocked(verifyNativeGoogleIdToken);
const mockExchangeNativeGoogleAuthCode = jest.mocked(exchangeNativeGoogleAuthCode);
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
const mockValidateAdmissionPayload = jest.mocked(validateAdmissionPayload);
const mockVerifyAdmissionAsync = jest.mocked(verifyAdmissionAsync);
const mockPersistAttestedKey = jest.mocked(persistAttestedKey);
const mockShouldRefuseAsyncFailure = jest.mocked(shouldRefuseAsyncFailure);
const mockCreateDeviceSession = jest.mocked(createDeviceSession);
const mockIssueSessionCredentials = jest.mocked(issueSessionCredentials);
const mockCreateDeviceSessionWithAttestedKey = jest.mocked(createDeviceSessionWithAttestedKey);
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
    mockCheckNativeAdmission.mockReturnValue({ admission: { ok: true }, verifyAsync: true });
    mockValidateAdmissionPayload.mockReturnValue(undefined);
    mockVerifyAdmissionAsync.mockResolvedValue({ ok: true, platform: 'ios', keyId: 'key1' });
    mockPersistAttestedKey.mockResolvedValue(undefined);
    mockShouldRefuseAsyncFailure.mockReturnValue(false);
    mockCreateDeviceSessionWithAttestedKey.mockResolvedValue({
      token: 'short-jwt',
      refreshToken: 'refresh-xyz',
      expiresIn: 3600,
      sessionId: 'session-1',
    });
    mockReserveSignInCode.mockResolvedValue('ok');
    mockCommitSignInCode.mockResolvedValue(true);
    mockReleaseSignInCode.mockResolvedValue(undefined);
    mockConsumeSignInCode.mockResolvedValue(true);
  });

  describe('apple', () => {
    it('builds args mirroring createAppleAccountInfo, autoLink=true, and mints a token', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'apple', idToken: 'apple-id-token', fullName: 'Jane Doe' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt', created: false });
      expect(mockVerifyNativeAppleIdToken).toHaveBeenCalledWith('apple-id-token', undefined);
      expect(mockCreateOrUpdateUser).toHaveBeenCalledWith(
        expect.objectContaining({
          google_user_email: 'appleuser@example.com',
          google_user_name: 'Jane Doe',
          hosted_domain: '@@apple@@',
          provider: 'apple',
          provider_account_id: 'apple-sub-1',
        }),
        undefined,
        true,
        expect.any(Headers),
        undefined,
        undefined,
        true
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
        true,
        expect.any(Headers),
        undefined,
        undefined,
        true
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

    // C12: nonce forwarding
    it('passes the raw nonce to verifyNativeAppleIdToken', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          nonce: 'raw-nonce-from-client',
        })
      );

      expect(response.status).toBe(200);
      expect(mockVerifyNativeAppleIdToken).toHaveBeenCalledWith(
        'apple-id-token',
        'raw-nonce-from-client'
      );
    });

    it('provides no nonce when the client sends none (legacy)', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });

      const response = await POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }));

      expect(response.status).toBe(200);
      expect(mockVerifyNativeAppleIdToken).toHaveBeenCalledWith('apple-id-token', undefined);
    });
  });

  describe('google', () => {
    it('builds args mirroring createGoogleAccountInfo (using hd) and autoLink=true', async () => {
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
      expect(data).toEqual({ token: 'minted-jwt', created: false });
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
        true,
        expect.any(Headers),
        undefined,
        undefined,
        true
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
        true,
        expect.any(Headers),
        undefined,
        undefined,
        true
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
      expect(data).toEqual({ token: 'minted-jwt', created: false });
      expect(mockCreateOrUpdateUser).toHaveBeenCalled();
    });

    // C12: Google serverAuthCode flow
    it('uses exchangeNativeGoogleAuthCode when serverAuthCode is present', async () => {
      mockExchangeNativeGoogleAuthCode.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
        name: 'Google User',
        picture: 'https://example.com/pic.png',
        hd: 'example.com',
      });

      const response = await POST(
        createRequest({
          provider: 'google',
          serverAuthCode: 'auth-code-123',
          googleClientId: 'web-client-id',
        })
      );

      expect(response.status).toBe(200);
      expect(mockExchangeNativeGoogleAuthCode).toHaveBeenCalledWith('auth-code-123');
      expect(mockVerifyNativeGoogleIdToken).not.toHaveBeenCalled();
      expect(mockCaptureMessage).not.toHaveBeenCalledWith('native_google_idtoken_legacy_count: 1');
    });

    it('falls back to verifyNativeGoogleIdToken when only idToken is present and counts legacy', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(200);
      expect(mockVerifyNativeGoogleIdToken).toHaveBeenCalledWith('google-id-token');
      expect(mockExchangeNativeGoogleAuthCode).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_google_idtoken_legacy_count: 1');
    });

    it('returns 400 INVALID_REQUEST when neither serverAuthCode nor idToken is provided', async () => {
      const response = await POST(createRequest({ provider: 'google' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ error: 'INVALID_REQUEST' });
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });

    it('returns 401 INVALID_TOKEN when serverAuthCode exchange fails with NativeIdTokenError', async () => {
      mockExchangeNativeGoogleAuthCode.mockRejectedValue(new NativeIdTokenError('exchange failed'));

      const response = await POST(
        createRequest({
          provider: 'google',
          serverAuthCode: 'replayed-code',
          googleClientId: 'web-client-id',
        })
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ error: 'INVALID_TOKEN' });
    });

    it('rethrows (500) when serverAuthCode exchange fails with a non-token error (network failure)', async () => {
      const networkError = new Error('connect ETIMEDOUT');
      mockExchangeNativeGoogleAuthCode.mockRejectedValue(networkError);

      await expect(
        POST(
          createRequest({
            provider: 'google',
            serverAuthCode: 'auth-code',
            googleClientId: 'web-client-id',
          })
        )
      ).rejects.toBe(networkError);
    });

    it('rejects a serverAuthCode from a different mobile web client', async () => {
      const response = await POST(
        createRequest({
          provider: 'google',
          serverAuthCode: 'auth-code',
          googleClientId: 'wrong-client-id',
        })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'INVALID_REQUEST' });
      expect(mockExchangeNativeGoogleAuthCode).not.toHaveBeenCalled();
      expect(mockCreateOrUpdateUser).not.toHaveBeenCalled();
    });
  });

  describe('email', () => {
    it('reserves, settles, commits, and mints a token', async () => {
      const response = await POST(
        createRequest({ provider: 'email', email: 'emailuser@example.com', code: '123456' })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt', created: false });
      expect(mockReserveSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456',
        undefined
      );
      expect(mockCommitSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456',
        undefined
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
        expect.any(Headers),
        undefined,
        undefined,
        true
      );
      expect(mockCheckDomainSignInEligibility).toHaveBeenCalledWith('emailuser@example.com');
      expect(mockReleaseSignInCode).not.toHaveBeenCalled();
      expect(mockConsumeSignInCode).not.toHaveBeenCalled();
    });

    it('passes challengeId through to reserve/commit when the client sends it', async () => {
      const challengeId = 'c0000000-0000-4000-8000-000000000001';
      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          challengeId,
        })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual({ token: 'minted-jwt', created: false });
      expect(mockReserveSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456',
        challengeId
      );
      expect(mockCommitSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456',
        challengeId
      );
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
        expect.any(Headers),
        undefined,
        undefined,
        true
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

    it('returns 401 INVALID_CODE for a challengeId from an ineligible OTP response', async () => {
      // The OTP route returns a fake challengeId for blocked or invalid
      // addresses. Token verification must treat it as INVALID_CODE.
      mockReserveSignInCode.mockResolvedValue('invalid');

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'blocked@example.com',
          code: '123456',
          challengeId: 'a0000000-0000-4000-8000-000000000999',
        })
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'INVALID_CODE' });
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
      expect(mockReleaseSignInCode).toHaveBeenCalledWith(email, code, undefined);
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockConsumeSignInCode).not.toHaveBeenCalled();

      // Second attempt: code was released, re-reserve succeeds, settle works.
      const second = await POST(createRequest({ provider: 'email', email, code }));
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ token: 'minted-jwt', created: false });

      // One account minted across both attempts.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(2);
      expect(mockGenerateApiToken).toHaveBeenCalledTimes(1);
      expect(mockCommitSignInCode).toHaveBeenCalledTimes(1);
      expect(mockCommitSignInCode).toHaveBeenCalledWith(email, code, undefined);
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
      expect(mockConsumeSignInCode).toHaveBeenCalledWith(
        'emailuser@example.com',
        '123456',
        undefined
      );
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
        created: false,
      });

      // One account, one session, no legacy token.
      expect(mockCreateOrUpdateUser).toHaveBeenCalledTimes(1);
      expect(mockCreateDeviceSession).toHaveBeenCalledTimes(1);
      expect(mockIssueSessionCredentials).toHaveBeenCalledTimes(1);
      expect(mockConsumeSignInCode).toHaveBeenCalledWith('lapse@example.com', '123456', undefined);
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

  it('refuses eligibility before persisting a device session, refresh token, or attested key (apple/google)', async () => {
    mockVerifyNativeGoogleIdToken.mockResolvedValue({
      sub: 'google-sub-1',
      email: 'googleuser@example.com',
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
    mockVerifyAdmissionAsync.mockResolvedValue({
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      publicKey: 'base64pubkey',
    });

    const response = await POST(
      createRequest({
        provider: 'google',
        idToken: 'google-id-token',
        supportsRefresh: true,
        admission: {},
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'SSO_ERROR',
      ssoOrganizationId: 'workos-organization-id',
    });
    // No credential-bearing side effects may run before the refusal.
    expect(mockCreateDeviceSessionWithAttestedKey).not.toHaveBeenCalled();
    expect(mockPersistAttestedKey).not.toHaveBeenCalled();
    expect(mockCreateDeviceSession).not.toHaveBeenCalled();
    expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
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
        admission: {
          ok: false,
          errorCode: 'ADMISSION_REQUIRED',
        },
        verifyAsync: false,
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

    // ── Fix 3: ownership check before code commit (email path) ─────────

    it('refuses ownership mismatch WITHOUT consuming the sign-in code (enforce, email path)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'assertion',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        signCount: 11,
        existingKeyUserId: 'other-user',
      });

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      // Code must NOT be committed — ownership check happens before commit.
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockReleaseSignInCode).toHaveBeenCalled();
    });

    // ── Fix 1: KeyCollisionError is not swallowed ─────────────────────

    // ── C14 repair: report mode logs mismatch and issues credentials ─

    it('logs ownership mismatch and issues credentials in report mode (email path)', async () => {
      // shouldRefuseAsyncFailure defaults to false (report mode)
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'assertion',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        signCount: 11,
        existingKeyUserId: 'other-user',
      });

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          admission: {},
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
      // Ownership mismatch is logged before code commit.
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_attested_key_ownership_mismatch');
      // Code is committed and credentials are issued.
      expect(mockCommitSignInCode).toHaveBeenCalled();
      expect(mockReleaseSignInCode).not.toHaveBeenCalled();
      // Key persistence is skipped — mismatch was detected pre-commit.
      expect(mockPersistAttestedKey).not.toHaveBeenCalled();
    });

    it('refuses attestation key collision before code commit (enforce, email path)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
        existingKeyUserId: 'other-user',
      });

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      // Code must NOT be committed — attestation ownership is checked pre-commit.
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockReleaseSignInCode).toHaveBeenCalled();
    });

    // ── Fix 3: KeyCollisionError during persistence does not burn the code ─

    it('refuses key collision during persistence without burning the sign-in code (enforce, email, supportsRefresh)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      // Verification succeeds with no prior owner — passes preflight ownership check.
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
        // No existingKeyUserId — preflight check passes.
      });
      // But the transactional persistence throws KeyCollisionError (concurrent insert).
      mockCreateDeviceSessionWithAttestedKey.mockRejectedValue(new KeyCollisionError());

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          supportsRefresh: true,
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      // Code must NOT be committed — persistence failed BEFORE commit.
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      // Code must be released so it remains usable.
      expect(mockReleaseSignInCode).toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_attested_key_cross_user_collision');
    });

    it('refuses key collision during persistence without burning the sign-in code (enforce, email, no supportsRefresh)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      });
      mockPersistAttestedKey.mockRejectedValue(new KeyCollisionError());

      const response = await POST(
        createRequest({
          provider: 'email',
          email: 'emailuser@example.com',
          code: '123456',
          supportsRefresh: false,
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      expect(mockCommitSignInCode).not.toHaveBeenCalled();
      expect(mockReleaseSignInCode).toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_attested_key_cross_user_collision');
    });

    it('logs ownership mismatch and issues token in report mode (apple/google)', async () => {
      // shouldRefuseAsyncFailure defaults to false (report mode)
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'assertion',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        signCount: 11,
        existingKeyUserId: 'other-user',
      });

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          admission: {},
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_attested_key_ownership_mismatch');
      // Key persistence is skipped.
      expect(mockPersistAttestedKey).not.toHaveBeenCalled();
    });

    it('logs KeyCollisionError and issues token in report mode (apple/google, no supportsRefresh)', async () => {
      // shouldRefuseAsyncFailure defaults to false (report mode)
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      });
      mockPersistAttestedKey.mockRejectedValue(new KeyCollisionError());

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          admission: {},
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_attested_key_cross_user_collision');
    });

    // ── Fix 1: KeyCollisionError is not swallowed ─────────────────────

    it('returns 403 ADMISSION_REQUIRED when persistAttestedKey throws KeyCollisionError (enforce, apple/google, no supportsRefresh)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      });
      mockPersistAttestedKey.mockRejectedValue(new KeyCollisionError());

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      // Must not issue credentials after collision.
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
    });

    it('returns 403 ADMISSION_REQUIRED when createDeviceSessionWithAttestedKey throws KeyCollisionError (enforce, apple/google, supportsRefresh)', async () => {
      mockShouldRefuseAsyncFailure.mockReturnValue(true);
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      });
      mockCreateDeviceSessionWithAttestedKey.mockRejectedValue(new KeyCollisionError());

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          supportsRefresh: true,
          admission: {},
        })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'ADMISSION_REQUIRED' });
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
    });

    // ── Fix 6: attestation key + session in one transaction ────────────

    it('uses createDeviceSessionWithAttestedKey when attestation and supportsRefresh', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockValidateAdmissionPayload.mockReturnValue({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'ch123',
        payload: 'data',
        keyId: 'key1',
      });
      mockVerifyAdmissionAsync.mockResolvedValue({
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      });
      mockCreateDeviceSessionWithAttestedKey.mockResolvedValue({
        token: 'short-jwt',
        refreshToken: 'refresh-abc',
        expiresIn: 3600,
        sessionId: 'session-1',
      });

      const response = await POST(
        createRequest({
          provider: 'apple',
          idToken: 'apple-id-token',
          supportsRefresh: true,
          admission: {},
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        token: 'short-jwt',
        refreshToken: 'refresh-abc',
        expiresIn: 3600,
        created: false,
      });
      // Must use the transactional combined function, not separate calls.
      expect(mockCreateDeviceSessionWithAttestedKey).toHaveBeenCalledWith({
        userId: fakeUser.id,
        userAgent: undefined,
        user: fakeUser,
        verification: expect.objectContaining({
          platform: 'ios',
          keyId: 'key1',
          publicKey: 'base64pubkey',
        }),
      });
      expect(mockCreateDeviceSession).not.toHaveBeenCalled();
      expect(mockIssueSessionCredentials).not.toHaveBeenCalled();
      expect(mockPersistAttestedKey).not.toHaveBeenCalled();
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
        created: false,
      });
      expect(mockCreateDeviceSession).toHaveBeenCalledWith({
        userId: fakeUser.id,
        userAgent: undefined, // NextRequest has no user-agent header by default
      });
      expect(mockIssueSessionCredentials).toHaveBeenCalledWith(fakeUser, 'session-1');
      expect(mockGenerateApiToken).not.toHaveBeenCalled();
      // idToken path records legacy use even with supportsRefresh.
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_google_idtoken_legacy_count: 1');
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
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
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
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
      expect(mockCreateDeviceSession).not.toHaveBeenCalled();
      expect(mockCaptureMessage).toHaveBeenCalledWith('native_token_legacy_long_lived_count: 1');
    });
  });

  describe('deferred sign-in analytics', () => {
    const deferredEvent = {
      distinctId: 'googleuser@example.com',
      event: 'user_signed_in',
      properties: { name: 'Google User', id: 'user-1' },
    };

    beforeEach(() => {
      mockPosthogCapture.mockClear();
    });

    it('does not emit deferred sign-in event when user is blocked at post-settlement gate', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: { ...fakeUser, blocked_reason: 'manual block' },
        isNew: false,
        deferredSignInEvent: deferredEvent,
      } as never);

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'BLOCKED' });
      expect(mockPosthogCapture).not.toHaveBeenCalled();
    });

    it('does not emit deferred sign-in event when SSO is required', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: { ...fakeUser, google_user_email: 'user@sso-required.com' },
        isNew: false,
        deferredSignInEvent: deferredEvent,
      } as never);
      mockCheckDomainSignInEligibility
        .mockResolvedValueOnce({ ok: true, existingUser: false })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          errorCode: 'SSO_ERROR',
          ssoOrganizationId: 'workos-organization-id',
        });

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'SSO_ERROR',
        ssoOrganizationId: 'workos-organization-id',
      });
      expect(mockPosthogCapture).not.toHaveBeenCalled();
    });

    it('emits deferred sign-in event after all gates pass for successful native sign-in', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: fakeUser,
        isNew: false,
        deferredSignInEvent: deferredEvent,
      } as never);

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(200);
      expect(mockPosthogCapture).toHaveBeenCalledWith(deferredEvent);
      expect(mockPosthogCapture).toHaveBeenCalledTimes(1);
    });

    it('does not emit when createOrUpdateUser returns success without deferred event (new user sign-up)', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: fakeUser,
        isNew: true,
        // no deferredSignInEvent — new user sign-up, not a sign-in
      } as never);

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(200);
      expect(mockPosthogCapture).not.toHaveBeenCalled();
    });
  });

  describe('created field', () => {
    it('returns created: true for a new account on the email path', async () => {
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: fakeUser,
        isNew: true,
      } as never);

      const response = await POST(
        createRequest({ provider: 'email', email: 'new@example.com', code: '123456' })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: true });
    });

    it('returns created: true for a new account on the apple path', async () => {
      mockVerifyNativeAppleIdToken.mockResolvedValue({
        sub: 'apple-sub-1',
        email: 'appleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: fakeUser,
        isNew: true,
      } as never);

      const response = await POST(createRequest({ provider: 'apple', idToken: 'apple-id-token' }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: true });
    });

    it('returns created: true for a new account on the google path', async () => {
      mockVerifyNativeGoogleIdToken.mockResolvedValue({
        sub: 'google-sub-1',
        email: 'googleuser@example.com',
      });
      mockCreateOrUpdateUser.mockResolvedValue({
        success: true,
        user: fakeUser,
        isNew: true,
      } as never);

      const response = await POST(
        createRequest({ provider: 'google', idToken: 'google-id-token' })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: true });
    });

    it('returns created: false for an existing account on the email path', async () => {
      const response = await POST(
        createRequest({ provider: 'email', email: 'existing@example.com', code: '123456' })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'minted-jwt', created: false });
    });
  });
});
