import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { validateKiloToken } from './jwt';
import { KILO_TOKEN_VERSION } from '../config';
import { KILOCLAW_AUDIENCE } from '@kilocode/worker-utils';

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

  it('accepts the KiloClaw audience as a string or array member', async () => {
    for (const aud of [KILOCLAW_AUDIENCE, ['another-resource', KILOCLAW_AUDIENCE]]) {
      const token = await signToken({
        kiloUserId: 'user_123',
        apiTokenPepper: 'pepper_abc',
        version: KILO_TOKEN_VERSION,
        aud,
      });

      await expect(validateKiloToken(token, TEST_SECRET, undefined)).resolves.toMatchObject({
        success: true,
        userId: 'user_123',
        token,
        pepper: 'pepper_abc',
      });
    }
  });

  it('rejects wrong and malformed audiences', async () => {
    for (const aud of ['another-resource', [], [' kiloclaw']]) {
      const token = await signToken({
        kiloUserId: 'user_123',
        apiTokenPepper: 'pepper_abc',
        version: KILO_TOKEN_VERSION,
        aud,
      });

      await expect(validateKiloToken(token, TEST_SECRET, undefined)).resolves.toMatchObject({
        success: false,
      });
    }
  });

  it('preserves legacy tokens without an audience or date claims', async () => {
    const token = await new SignJWT({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(TEST_SECRET));

    await expect(validateKiloToken(token, TEST_SECRET, undefined)).resolves.toEqual({
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
    expect(result.success).toBe(false);
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
      error: 'Invalid token',
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

describe('C15 deviceSessionId compatibility', () => {
  it('accepts a token carrying deviceSessionId claim', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'pepper_abc',
      version: KILO_TOKEN_VERSION,
      env: 'development',
      deviceSessionId: 'session-xyz-456',
    });

    const result = await validateKiloToken(token, TEST_SECRET, 'development');
    expect(result).toEqual({
      success: true,
      userId: 'user_123',
      token,
      pepper: 'pepper_abc',
    });
  });
});
