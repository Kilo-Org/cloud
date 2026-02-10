import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { validateKiloToken } from './jwt';
import { KILO_TOKEN_VERSION } from '../config';

const TEST_SECRET = 'test-secret-for-jwt-verification';

async function signToken(
  payload: Record<string, unknown>,
  options?: { secret?: string; exp?: number | string }
) {
  const secret = new TextEncoder().encode(options?.secret ?? TEST_SECRET);
  let builder = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
  if (typeof options?.exp === 'number') {
    builder = builder.setExpirationTime(options.exp);
  } else {
    builder = builder.setExpirationTime(options?.exp ?? '1h');
  }
  return builder.sign(secret);
}

describe('validateKiloToken', () => {
  it('validates a well-formed token', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
      env: 'development',
    });

    const result = await validateKiloToken(token, TEST_SECRET, 'development');
    expect(result).toEqual({
      success: true,
      userId: 'user_123',
      token,
      pepper: 'pepper_abc',
    });
  });

  it('rejects wrong token version', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION - 1,
    });

    const result = await validateKiloToken(token, TEST_SECRET, undefined);
    expect(result).toEqual({
      success: false,
      error: `Invalid token version: ${KILO_TOKEN_VERSION - 1}`,
    });
  });

  it('rejects env mismatch', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
      env: 'production',
    });

    const result = await validateKiloToken(token, TEST_SECRET, 'development');
    expect(result).toEqual({
      success: false,
      error: 'Token env mismatch: production !== development',
    });
  });

  it('allows missing env in token when expectedEnv is set', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
    });

    const result = await validateKiloToken(token, TEST_SECRET, 'production');
    expect(result.success).toBe(true);
  });

  it('allows missing expectedEnv when token has env', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
      env: 'production',
    });

    const result = await validateKiloToken(token, TEST_SECRET, undefined);
    expect(result.success).toBe(true);
  });

  it('rejects expired tokens', async () => {
    // Set exp to 1 hour in the past -- no sleep needed
    const token = await signToken(
      {
        kiloUserId: 'user_123',
        apiTokenPepper: 'pepper_abc',
        version: KILO_TOKEN_VERSION,
      },
      { exp: Math.floor(Date.now() / 1000) - 3600 }
    );

    const result = await validateKiloToken(token, TEST_SECRET, undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('exp');
    }
  });

  it('rejects tokens signed with wrong secret', async () => {
    const token = await signToken(
      {
        kiloUserId: 'user_123',
        apiTokenPepper: 'pepper_abc',
        version: KILO_TOKEN_VERSION,
      },
      { secret: 'wrong-secret' }
    );

    const result = await validateKiloToken(token, TEST_SECRET, undefined);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('signature');
    }
  });

  it('rejects malformed tokens', async () => {
    const result = await validateKiloToken('not-a-jwt', TEST_SECRET, undefined);
    expect(result.success).toBe(false);
  });
});
