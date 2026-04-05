import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JWTVerifyResult, ResolvedKey } from 'jose';

// Mock jose before importing oidc
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

import { validateOidcToken, _resetJwks } from './oidc';
import * as jose from 'jose';

const mockJwtVerify = vi.mocked(jose.jwtVerify);

const TEST_AUDIENCE = 'https://audience.example.com';
const TEST_SA_EMAIL = 'gmail-push@my-project.iam.gserviceaccount.com';

function mockVerifyResult(
  payload: Record<string, unknown>
): JWTVerifyResult<unknown> & ResolvedKey {
  return {
    payload,
    protectedHeader: { alg: 'RS256' },
    key: {} as CryptoKey,
  } as JWTVerifyResult<unknown> & ResolvedKey;
}

describe('validateOidcToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetJwks();
  });

  it('rejects missing authorization header', async () => {
    const result = await validateOidcToken(null, TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
  });

  it('rejects non-Bearer scheme', async () => {
    const result = await validateOidcToken('Basic abc123', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
  });

  it('rejects empty token', async () => {
    const result = await validateOidcToken('Bearer ', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
  });

  it('accepts valid token with correct email', async () => {
    mockJwtVerify.mockResolvedValue(
      mockVerifyResult({
        email: TEST_SA_EMAIL,
        email_verified: true,
        iss: 'https://accounts.google.com',
      })
    );

    const result = await validateOidcToken('Bearer valid-token', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.email).toBe(TEST_SA_EMAIL);
    }
  });

  it('rejects token with email_verified=false', async () => {
    mockJwtVerify.mockResolvedValue(
      mockVerifyResult({
        email: TEST_SA_EMAIL,
        email_verified: false,
      })
    );

    const result = await validateOidcToken('Bearer valid-token', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('not verified');
    }
  });

  it('rejects valid token with wrong email', async () => {
    mockJwtVerify.mockResolvedValue(
      mockVerifyResult({
        email: 'attacker@evil-project.iam.gserviceaccount.com',
        email_verified: true,
      })
    );

    const result = await validateOidcToken('Bearer valid-token', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('Unexpected email');
    }
  });

  it('rejects token with missing email claim', async () => {
    mockJwtVerify.mockResolvedValue(mockVerifyResult({ iss: 'https://accounts.google.com' }));

    const result = await validateOidcToken('Bearer valid-token', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
  });

  it('rejects expired or invalid token', async () => {
    mockJwtVerify.mockRejectedValue(new Error('"exp" claim timestamp check failed'));

    const result = await validateOidcToken('Bearer expired-token', TEST_AUDIENCE, TEST_SA_EMAIL);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('exp');
    }
  });

  it('passes correct audience to jwtVerify', async () => {
    mockJwtVerify.mockResolvedValue(
      mockVerifyResult({ email: TEST_SA_EMAIL, email_verified: true })
    );

    await validateOidcToken('Bearer some-token', 'https://my-audience.example.com', TEST_SA_EMAIL);

    expect(mockJwtVerify).toHaveBeenCalledWith(
      'some-token',
      expect.any(Function),
      expect.objectContaining({
        issuer: 'https://accounts.google.com',
        audience: 'https://my-audience.example.com',
      })
    );
  });
});
