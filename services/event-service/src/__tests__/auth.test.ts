import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSecretCacheForTest,
  EVENT_SERVICE_AUDIENCE,
  signKiloToken,
} from '@kilocode/worker-utils';
import { type KiloUserPepperResult } from '@kilocode/worker-utils/kilo-token-auth';
import { type AuthEnv, authenticateToken } from '../auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const currentPepperByUserId = new Map<string, KiloUserPepperResult>();

function makeEnv(): AuthEnv {
  return {
    NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
    HYPERDRIVE: { connectionString: 'postgres://test' },
    WORKER_ENV: 'production',
  };
}

async function getUserPepper(
  _connectionString: string,
  userId: string
): Promise<KiloUserPepperResult | null | undefined> {
  return currentPepperByUserId.has(userId) ? currentPepperByUserId.get(userId)! : undefined;
}

function authenticateTestToken(token: string | null) {
  return authenticateToken(token, makeEnv(), { getUserPepper });
}

function signEventServiceToken(params: { pepper?: string | null; env?: string } = {}) {
  return signKiloToken({
    userId: 'user-xyz-789',
    pepper: params.pepper,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: params.env,
    audience: EVENT_SERVICE_AUDIENCE,
  });
}

async function signWithAudience(aud: unknown): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${json({ alg: 'HS256', typ: 'JWT' })}.${json({
    version: 3,
    kiloUserId: 'user-xyz-789',
    apiTokenPepper: 'pepper-current',
    env: 'production',
    aud,
    iat: now,
    exp: now + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TEST_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${encode(new Uint8Array(signature))}`;
}

describe('authenticateToken', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    currentPepperByUserId.clear();
    currentPepperByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
  });

  it('authenticates a legacy one-hour kilo-chat token without an audience', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
    });

    await expect(authenticateTestToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('authenticates a valid JWT from another token source', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'cloud-agent' },
    });

    await expect(authenticateTestToken(token)).resolves.toEqual({
      userId: 'user-xyz-789',
    });
  });

  it('authenticates event-service audience claims as strings and arrays', async () => {
    const arrayAudienceToken = await signWithAudience(['another-service', EVENT_SERVICE_AUDIENCE]);
    const stringAudienceToken = await signEventServiceToken({
      pepper: 'pepper-current',
      env: 'production',
    });

    await expect(authenticateTestToken(stringAudienceToken.token)).resolves.toEqual({
      userId: 'user-xyz-789',
    });
    await expect(authenticateTestToken(arrayAudienceToken)).resolves.toEqual({
      userId: 'user-xyz-789',
    });
  });

  it('rejects wrong or malformed event-service audiences before pepper lookup', async () => {
    const malformedAudienceToken = await signWithAudience([
      EVENT_SERVICE_AUDIENCE,
      EVENT_SERVICE_AUDIENCE,
    ]);
    const wrongAudienceToken = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'another-service',
    });
    let lookupCount = 0;
    const lookup = async (...args: Parameters<typeof getUserPepper>) => {
      lookupCount++;
      return getUserPepper(...args);
    };

    await expect(
      authenticateToken(wrongAudienceToken.token, makeEnv(), { getUserPepper: lookup })
    ).resolves.toBeNull();
    await expect(
      authenticateToken(malformedAudienceToken, makeEnv(), { getUserPepper: lookup })
    ).resolves.toBeNull();
    expect(lookupCount).toBe(0);
  });

  it('rejects a valid kilo-chat JWT with a stale pepper', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-stale',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
    });

    await expect(authenticateTestToken(token)).resolves.toBeNull();
  });

  it('rejects a valid kilo-chat JWT minted for a different environment', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'development',
      extra: { tokenSource: 'kilo-chat' },
    });

    await expect(authenticateTestToken(token)).resolves.toBeNull();
  });

  it('rejects event-service tokens with missing or mismatched environments', async () => {
    const [missingEnvironment, mismatchedEnvironment] = await Promise.all([
      signEventServiceToken({ pepper: 'pepper-current' }),
      signEventServiceToken({ pepper: 'pepper-current', env: 'development' }),
    ]);

    await expect(authenticateTestToken(missingEnvironment.token)).resolves.toBeNull();
    await expect(authenticateTestToken(mismatchedEnvironment.token)).resolves.toBeNull();
  });

  it('rejects a token for a blocked user even when pepper matches', async () => {
    currentPepperByUserId.set('user-xyz-789', {
      pepper: 'pepper-current',
      blockedReason: 'manual block',
    });
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
    });

    await expect(authenticateTestToken(token)).resolves.toBeNull();
  });

  it('rejects missing users, stale peppers, and a null pepper against a stored pepper', async () => {
    const [stalePepper, nullPepper] = await Promise.all([
      signEventServiceToken({ pepper: 'pepper-stale', env: 'production' }),
      signEventServiceToken({ pepper: null, env: 'production' }),
    ]);

    await expect(authenticateTestToken(stalePepper.token)).resolves.toBeNull();
    await expect(authenticateTestToken(nullPepper.token)).resolves.toBeNull();
    const validToken = await signEventServiceToken({ pepper: 'pepper-current', env: 'production' });
    await expect(authenticateTestToken(validToken.token)).resolves.toEqual({
      userId: 'user-xyz-789',
    });
    currentPepperByUserId.clear();
    const lookup = vi.fn(getUserPepper);
    await expect(
      authenticateToken(validToken.token, makeEnv(), { getUserPepper: lookup })
    ).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledWith('postgres://test', 'user-xyz-789');
  });

  it('allows absent peppers but rejects explicit null peppers for a user with a current pepper', async () => {
    const absentPepper = await signEventServiceToken({ env: 'production' });
    const nullPepper = await signEventServiceToken({ pepper: null, env: 'production' });

    await expect(authenticateTestToken(absentPepper.token)).resolves.toEqual({
      userId: 'user-xyz-789',
    });
    await expect(authenticateTestToken(nullPepper.token)).resolves.toBeNull();
  });

  it('propagates secret and pepper lookup failures', async () => {
    const { token } = await signEventServiceToken({ pepper: 'pepper-current', env: 'production' });

    await expect(
      authenticateToken(
        token,
        {
          ...makeEnv(),
          NEXTAUTH_SECRET: { get: async () => Promise.reject(new Error('secret unavailable')) },
        },
        { getUserPepper }
      )
    ).rejects.toThrow('secret unavailable');
    clearSecretCacheForTest();
    await expect(
      authenticateToken(token, makeEnv(), {
        getUserPepper: async () => Promise.reject(new Error('lookup unavailable')),
      })
    ).rejects.toThrow('lookup unavailable');
  });
});
