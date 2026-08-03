import { beforeEach, describe, expect, it } from 'vitest';

import { clearSecretCacheForTest } from './cached-secret';
import { signKiloToken } from './kilo-token';
import { verifyKiloBearerAgainstCurrentPepper, type KiloUserPepperResult } from './kilo-token-auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userResultByUserId = new Map<string, KiloUserPepperResult>();

async function getUserPepper(
  _connectionString: string,
  userId: string
): Promise<KiloUserPepperResult | null | undefined> {
  return userResultByUserId.has(userId) ? userResultByUserId.get(userId)! : undefined;
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
    userResultByUserId.clear();
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
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
    userResultByUserId.clear();
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens with stale peppers', async () => {
    const { token } = await signToken({ pepper: 'pepper-stale', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens for blocked users (pepper matches, but blocked_reason is set)', async () => {
    userResultByUserId.set('user-xyz-789', {
      pepper: 'pepper-current',
      blockedReason: 'manual block',
    });
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens for blocked users even when the stored pepper is null', async () => {
    userResultByUserId.set('user-xyz-789', {
      pepper: null,
      blockedReason: 'soft-deleted at 2026-01-01T00:00:00.000Z',
    });
    const { token } = await signToken({ pepper: null, tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('accepts tokens when blockedReason is null and pepper matches', async () => {
    // Explicitly confirm null blockedReason + matching pepper passes.
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });
});
