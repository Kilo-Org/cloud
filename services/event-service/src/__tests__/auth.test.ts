import { beforeEach, describe, expect, it } from 'vitest';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { type AuthEnv, authenticateToken } from '../auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const currentPepperByUserId = new Map<string, string | null>();

function makeEnv(): AuthEnv {
  return {
    NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
    HYPERDRIVE: { connectionString: 'postgres://test' },
    WORKER_ENV: 'production',
  };
}

async function getUserPepper(_connectionString: string, userId: string) {
  return currentPepperByUserId.get(userId);
}

function authenticateTestToken(token: string | null) {
  return authenticateToken(token, makeEnv(), { getUserPepper });
}

describe('authenticateToken', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    currentPepperByUserId.clear();
    currentPepperByUserId.set('user-xyz-789', 'pepper-current');
  });

  it('authenticates a kilo-chat token with the current pepper', async () => {
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
});
