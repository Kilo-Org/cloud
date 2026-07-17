import { verifyAppleJwtWithJwks, AppleJwtClientError } from '@/lib/auth/apple-jwks';
import { OAuth2Client } from 'google-auth-library';
import type jwt from 'jsonwebtoken';

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
const mockConfig = { GOOGLE_IOS_CLIENT_ID: 'ios-client-id' };
jest.mock('@/lib/config.server', () => ({
  GOOGLE_CLIENT_ID: 'web-client-id',
  get GOOGLE_IOS_CLIENT_ID() {
    return mockConfig.GOOGLE_IOS_CLIENT_ID;
  },
}));

import {
  verifyNativeAppleIdToken,
  verifyNativeGoogleIdToken,
  NativeIdTokenError,
} from './native-id-tokens';

const mockVerifyAppleJwtWithJwks = jest.mocked(verifyAppleJwtWithJwks);
const mockGetFederatedSignonCertsAsync = jest.fn();
const mockVerifySignedJwtWithCertsAsync = jest.fn();

(OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
  getFederatedSignonCertsAsync: mockGetFederatedSignonCertsAsync,
  verifySignedJwtWithCertsAsync: mockVerifySignedJwtWithCertsAsync,
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

  it('throws when verifyIdToken rejects (invalid token)', async () => {
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
