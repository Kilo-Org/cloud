import { beforeEach, describe, expect, it } from 'vitest';

import { clearSecretCacheForTest } from './cached-secret';
import { signKiloToken } from './kilo-token';
import { verifyKiloBearerAgainstCurrentPepper } from './kilo-token-auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const currentPepperByUserId = new Map<string, string | null>();

async function getUserPepper(_connectionString: string, userId: string) {
  return currentPepperByUserId.has(userId) ? currentPepperByUserId.get(userId) : undefined;
}

async function signToken(params: {
  pepper: string | null;
  tokenSource: 'kilo-chat' | 'cloud-agent';
}) {
  return signKiloToken({
    userId: 'user-xyz-789',
    pepper: params.pepper,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: 'production',
    extra: { tokenSource: params.tokenSource },
  });
}

function verifyToken(token: string | null) {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: { get: async () => TEST_JWT_SECRET },
    workerEnv: 'production',
    connectionString: 'postgres://test',
    getUserPepper,
  });
}

describe('verifyKiloBearerAgainstCurrentPepper', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    currentPepperByUserId.clear();
    currentPepperByUserId.set('user-xyz-789', 'pepper-current');
  });

  it('accepts a token with the current user pepper', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('accepts valid tokens from any token source', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'cloud-agent' });

    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('rejects tokens for missing users', async () => {
    currentPepperByUserId.clear();
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens with stale peppers', async () => {
    const { token } = await signToken({ pepper: 'pepper-stale', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });
});
