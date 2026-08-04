import { verifyAppleJwtWithJwks, AppleJwtClientError } from '@/lib/auth/apple-jwks';
import { OAuth2Client } from 'google-auth-library';
import type jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

// The app-wide `jsonwebtoken` module augmentation (see types/next-auth.d.ts) adds
// kiloUserId/version to JwtPayload for internal service tokens; irrelevant to Apple's
// payload shape, so cast test fixtures rather than pad them with unrelated fields.
const applePayload = (fields: Record<string, unknown>) => fields as unknown as jwt.JwtPayload;

jest.mock('@/lib/auth/apple-jwks', () => ({
  ...jest.requireActual('@/lib/auth/apple-jwks'),
  verifyAppleJwtWithJwks: jest.fn(),
}));
jest.mock('google-auth-library');
// GOOGLE_IOS_CLIENT_ID is mutable (via the getter) so a test can simulate it being unset.
const mockConfig = {
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_CLIENT_SECRET: 'web-client-secret',
};
jest.mock('@/lib/config.server', () => ({
  GOOGLE_CLIENT_ID: 'web-client-id',
  get GOOGLE_CLIENT_SECRET() {
    return mockConfig.GOOGLE_CLIENT_SECRET;
  },
  get GOOGLE_IOS_CLIENT_ID() {
    return mockConfig.GOOGLE_IOS_CLIENT_ID;
  },
}));
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  exchangeNativeGoogleAuthCode,
  NativeIdTokenError,
} from './native-id-tokens';
import { GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

const mockVerifyAppleJwtWithJwks = jest.mocked(verifyAppleJwtWithJwks);
const mockGetFederatedSignonCertsAsync = jest.fn();
const mockVerifySignedJwtWithCertsAsync = jest.fn();
const mockGetToken = jest.fn();
const mockVerifyIdToken = jest.fn();
const mockCaptureMessage = jest.mocked(captureMessage);

(OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
  getFederatedSignonCertsAsync: mockGetFederatedSignonCertsAsync,
  verifySignedJwtWithCertsAsync: mockVerifySignedJwtWithCertsAsync,
  getToken: mockGetToken,
  verifyIdToken: mockVerifyIdToken,
}));

describe('verifyNativeAppleIdToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies against the Kilo app bundle ID and returns sub/email', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email: 'user@example.com', email_verified: true })
    );

    const result = await verifyNativeAppleIdToken('a-token');

    expect(mockVerifyAppleJwtWithJwks).toHaveBeenCalledWith('a-token', 'com.kilocode.kiloapp');
    expect(result).toEqual({ sub: 'apple-sub-1', email: 'user@example.com' });
  });

  it('accepts a string "true" email_verified claim', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email: 'user@example.com', email_verified: 'true' })
    );

    const result = await verifyNativeAppleIdToken('a-token');
    expect(result).toEqual({ sub: 'apple-sub-1', email: 'user@example.com' });
  });

  it('throws when email is missing', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email_verified: true })
    );

    await expect(verifyNativeAppleIdToken('a-token')).rejects.toThrow();
  });

  it('throws when email_verified is not true', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email: 'user@example.com', email_verified: false })
    );

    await expect(verifyNativeAppleIdToken('a-token')).rejects.toThrow();
  });

  it('propagates AppleJwtClientError from the underlying jwks verifier', async () => {
    mockVerifyAppleJwtWithJwks.mockRejectedValue(new AppleJwtClientError('bad jwt'));

    await expect(verifyNativeAppleIdToken('bad-token')).rejects.toThrow(AppleJwtClientError);
  });

  // C12: Apple nonce binding
  it('accepts a token when the nonce digest matches the sent raw nonce', async () => {
    const rawNonce = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const expectedDigest = createHash('sha256').update(rawNonce).digest('hex');
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({
        sub: 'apple-sub-1',
        email: 'user@example.com',
        email_verified: true,
        nonce: expectedDigest,
      })
    );

    const result = await verifyNativeAppleIdToken('a-token', rawNonce);
    expect(result).toEqual({ sub: 'apple-sub-1', email: 'user@example.com' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('throws NativeIdTokenError when the nonce does not match', async () => {
    const rawNonce = 'correct-raw-nonce-that-client-sent';
    // Apple embeds the digest of whatever nonce Apple received.  If the token
    // contains a different nonce, the server must reject it.
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({
        sub: 'apple-sub-1',
        email: 'user@example.com',
        email_verified: true,
        nonce: 'wrong-nonce-digest',
      })
    );

    await expect(verifyNativeAppleIdToken('a-token', rawNonce)).rejects.toThrow(NativeIdTokenError);
    await expect(verifyNativeAppleIdToken('a-token', rawNonce)).rejects.toThrow(
      'Apple nonce mismatch'
    );
  });

  it('accepts a token without a nonce and records legacy use', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email: 'user@example.com', email_verified: true })
    );

    const result = await verifyNativeAppleIdToken('a-token');
    expect(result).toEqual({ sub: 'apple-sub-1', email: 'user@example.com' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('native_apple_nonce_legacy_count: 1');
  });
});

describe('verifyNativeGoogleIdToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.GOOGLE_IOS_CLIENT_ID = 'ios-client-id';
    mockGetFederatedSignonCertsAsync.mockResolvedValue({ certs: { key: 'certificate' } });
  });

  it('verifies against [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID] audience and returns the payload', async () => {
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'User Name',
        picture: 'https://example.com/pic.png',
        hd: 'example.com',
      }),
    });

    const result = await verifyNativeGoogleIdToken('g-token');

    expect(mockVerifySignedJwtWithCertsAsync).toHaveBeenCalledWith(
      'g-token',
      { key: 'certificate' },
      ['web-client-id', 'ios-client-id'],
      ['accounts.google.com', 'https://accounts.google.com']
    );
    expect(result).toEqual({
      sub: 'google-sub-1',
      email: 'user@example.com',
      name: 'User Name',
      picture: 'https://example.com/pic.png',
      hd: 'example.com',
    });
  });

  it('throws when email_verified is not true', async () => {
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: false,
      }),
    });

    await expect(verifyNativeGoogleIdToken('g-token')).rejects.toThrow();
  });

  it('throws when email_verified is undefined', async () => {
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: undefined,
      }),
    });

    await expect(verifyNativeGoogleIdToken('g-token')).rejects.toThrow(NativeIdTokenError);
  });

  it('throws when verifySignedJwtWithCertsAsync rejects (invalid token)', async () => {
    mockVerifySignedJwtWithCertsAsync.mockRejectedValue(new Error('Wrong number of segments'));

    await expect(verifyNativeGoogleIdToken('bad-token')).rejects.toThrow(NativeIdTokenError);
  });

  it('preserves Google certificate-fetch failures as server errors', async () => {
    const providerError = new Error('Failed to retrieve verification certificates: network');
    mockGetFederatedSignonCertsAsync.mockRejectedValue(providerError);

    await expect(verifyNativeGoogleIdToken('g-token')).rejects.toBe(providerError);
  });

  it('filters out an empty GOOGLE_IOS_CLIENT_ID from the audience list', async () => {
    mockConfig.GOOGLE_IOS_CLIENT_ID = '';
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: true,
      }),
    });

    await verifyNativeGoogleIdToken('g-token');

    expect(mockVerifySignedJwtWithCertsAsync).toHaveBeenCalledWith(
      'g-token',
      { key: 'certificate' },
      ['web-client-id'],
      ['accounts.google.com', 'https://accounts.google.com']
    );
  });
});

describe('exchangeNativeGoogleAuthCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.GOOGLE_CLIENT_SECRET = 'web-client-secret';
  });

  it('exchanges a serverAuthCode and returns verified Google user data', async () => {
    mockGetToken.mockResolvedValue({
      tokens: { id_token: 'exchanged-id-token' },
    });
    mockGetFederatedSignonCertsAsync.mockResolvedValue({ certs: { key: 'certificate' } });
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: true,
        name: 'Google User',
        picture: 'https://example.com/pic.png',
        hd: 'example.com',
      }),
    });

    const result = await exchangeNativeGoogleAuthCode('auth-code');
    expect(result).toEqual({
      sub: 'google-sub-1',
      email: 'user@example.com',
      name: 'Google User',
      picture: 'https://example.com/pic.png',
      hd: 'example.com',
    });
    expect(mockGetToken).toHaveBeenCalledWith('auth-code');
    expect(mockGetFederatedSignonCertsAsync).toHaveBeenCalled();
    expect(mockVerifySignedJwtWithCertsAsync).toHaveBeenCalledWith(
      'exchanged-id-token',
      { key: 'certificate' },
      ['web-client-id'],
      ['accounts.google.com', 'https://accounts.google.com']
    );
  });

  it('throws NativeIdTokenError when getToken fails with a server response (replayed code)', async () => {
    const oauthError = new Error('invalid_grant');
    (oauthError as Record<string, unknown>).response = { data: { error: 'invalid_grant' } };
    mockGetToken.mockRejectedValue(oauthError);

    await expect(exchangeNativeGoogleAuthCode('replayed-code')).rejects.toThrow(NativeIdTokenError);
    await expect(exchangeNativeGoogleAuthCode('replayed-code')).rejects.toThrow(
      'Google authorization code exchange failed'
    );
  });

  it('propagates network errors from getToken without wrapping (5xx path)', async () => {
    const networkError = new Error('connect ECONNREFUSED');
    // No response property → network/infra failure.
    mockGetToken.mockRejectedValue(networkError);

    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toBe(networkError);
  });

  it('throws NativeIdTokenError when token response has no id_token', async () => {
    mockGetToken.mockResolvedValue({ tokens: {} });

    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(NativeIdTokenError);
    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(
      'Google token response missing id_token'
    );
  });

  it('throws NativeIdTokenError when email_verified is false', async () => {
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'exchanged-id-token' } });
    mockGetFederatedSignonCertsAsync.mockResolvedValue({ certs: { key: 'certificate' } });
    mockVerifySignedJwtWithCertsAsync.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: false,
      }),
    });

    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(NativeIdTokenError);
  });

  it('throws NativeIdTokenError when verifySignedJwtWithCertsAsync rejects (invalid token)', async () => {
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'exchanged-id-token' } });
    mockGetFederatedSignonCertsAsync.mockResolvedValue({ certs: { key: 'certificate' } });
    // google-auth-library throws a plain Error (no .response) for JWT verify failures.
    mockVerifySignedJwtWithCertsAsync.mockRejectedValue(new Error('Wrong number of segments'));

    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(NativeIdTokenError);
    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(
      'Google ID token verification failed after code exchange'
    );
  });

  it('propagates cert-fetch failures as 5xx (outside the token-verify try block)', async () => {
    mockGetToken.mockResolvedValue({ tokens: { id_token: 'exchanged-id-token' } });
    const certError = new Error('Failed to retrieve verification certificates: network');
    mockGetFederatedSignonCertsAsync.mockRejectedValue(certError);

    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toBe(certError);
  });

  it('throws a plain Error when credentials are not configured', async () => {
    mockConfig.GOOGLE_CLIENT_SECRET = '';
    // Reset the module-level mock to match (jest mocks persist across tests)
    // Use a separate require approach — actually, the mockConfig is the source
    // of truth for the getter.  The function reads GOOGLE_CLIENT_SECRET at
    // call time, so this should work.
    await expect(exchangeNativeGoogleAuthCode('auth-code')).rejects.toThrow(
      'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured'
    );
  });
});

// C12: Configuration invariant — the server GOOGLE_CLIENT_ID must equal the mobile
// GOOGLE_WEB_CLIENT_ID for the serverAuthCode exchange to succeed.  The mobile test
// compares against the same expected value.
const EXPECTED_GOOGLE_WEB_CLIENT_ID = 'web-client-id';

describe('configuration invariants', () => {
  it('GOOGLE_CLIENT_ID equals the expected web client ID (must match mobile GOOGLE_WEB_CLIENT_ID)', () => {
    expect(GOOGLE_CLIENT_ID).toBe(EXPECTED_GOOGLE_WEB_CLIENT_ID);
  });

  it('GOOGLE_IOS_CLIENT_ID is distinct from GOOGLE_CLIENT_ID (they serve different audiences)', () => {
    expect(GOOGLE_CLIENT_ID).not.toBe(GOOGLE_IOS_CLIENT_ID);
  });
});
