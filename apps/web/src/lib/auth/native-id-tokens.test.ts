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
jest.mock('@/lib/config.server', () => ({
  APPLE_NATIVE_CLIENT_IDS: 'com.kilocode.kiloapp',
  GOOGLE_CLIENT_ID: 'web-client-id',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
}));

import { verifyNativeAppleIdToken, verifyNativeGoogleIdToken } from './native-id-tokens';

const mockVerifyAppleJwtWithJwks = jest.mocked(verifyAppleJwtWithJwks);
const mockVerifyIdToken = jest.fn();

(OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
  verifyIdToken: mockVerifyIdToken,
}));

describe('verifyNativeAppleIdToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('verifies against the split APPLE_NATIVE_CLIENT_IDS audience and returns sub/email', async () => {
    mockVerifyAppleJwtWithJwks.mockResolvedValue(
      applePayload({ sub: 'apple-sub-1', email: 'user@example.com', email_verified: true })
    );

    const result = await verifyNativeAppleIdToken('a-token');

    expect(mockVerifyAppleJwtWithJwks).toHaveBeenCalledWith('a-token', ['com.kilocode.kiloapp']);
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
  });

  it('verifies against [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID] audience and returns the payload', async () => {
    mockVerifyIdToken.mockResolvedValue({
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

    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'g-token',
      audience: ['web-client-id', 'ios-client-id'],
    });
    expect(result).toEqual({
      sub: 'google-sub-1',
      email: 'user@example.com',
      name: 'User Name',
      picture: 'https://example.com/pic.png',
      hd: 'example.com',
    });
  });

  it('throws when email_verified is not true', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'user@example.com',
        email_verified: false,
      }),
    });

    await expect(verifyNativeGoogleIdToken('g-token')).rejects.toThrow();
  });

  it('throws when verifyIdToken rejects (invalid token)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Wrong number of segments'));

    await expect(verifyNativeGoogleIdToken('bad-token')).rejects.toThrow();
  });
});
