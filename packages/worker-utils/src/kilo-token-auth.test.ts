import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

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

  it('propagates a pepper-lookup failure instead of reporting an invalid token', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: { get: async () => TEST_JWT_SECRET },
        workerEnv: 'production',
        connectionString: 'postgres://test',
        getUserPepper: async () => {
          throw new Error('connection refused');
        },
      })
    ).rejects.toThrow('connection refused');
  });

  it('propagates a secret-store failure instead of reporting an invalid token', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: {
          get: async () => {
            throw new Error('secrets store unavailable');
          },
        },
        workerEnv: 'production',
        connectionString: 'postgres://test',
        getUserPepper,
      })
    ).rejects.toThrow('secrets store unavailable');
  });

  it('rejects tokens for missing users', async () => {
    userResultByUserId.clear();
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens when getUserPepper returns null', async () => {
    userResultByUserId.clear();
    // Simulate a custom getUserPepper that returns null instead of undefined
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token: await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' }).then(
          ({ token }) => token
        ),
        nextAuthSecret: { get: async () => TEST_JWT_SECRET },
        workerEnv: 'production',
        connectionString: 'postgres://test',
        getUserPepper: async () => null,
      })
    ).resolves.toBeNull();
  });

  it('rejects tokens with stale peppers', async () => {
    const { token } = await signToken({ pepper: 'pepper-stale', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects a user token with a null pepper when the stored pepper is non-null', async () => {
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
    const { token } = await signToken({ pepper: null, tokenSource: 'kilo-chat' });

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

  it('succeeds when a token with env is verified without workerEnv', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: { get: async () => TEST_JWT_SECRET },
        connectionString: 'postgres://test',
        getUserPepper,
      })
    ).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('fails when token env does not match a provided workerEnv', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: { get: async () => TEST_JWT_SECRET },
        workerEnv: 'staging',
        connectionString: 'postgres://test',
        getUserPepper,
      })
    ).resolves.toBeNull();
  });

  it('uses the existing verifier strictly by default before account lookup', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'resource-audience',
    });
    let lookupCount = 0;

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: TEST_JWT_SECRET,
        workerEnv: 'production',
        connectionString: 'postgres://test',
        getUserPepper: async (...args) => {
          lookupCount++;
          return getUserPepper(...args);
        },
      })
    ).resolves.toBeNull();
    expect(lookupCount).toBe(0);
  });

  it('dispatches the existing verifier audience option for string and array claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const arrayAudienceToken = await new SignJWT({
      version: 3,
      kiloUserId: 'user-xyz-789',
      apiTokenPepper: 'pepper-current',
      env: 'production',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(['other-resource', 'resource-audience'])
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));
    const matchingString = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'resource-audience',
    });
    const absentAudience = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });
    const mismatchedAudience = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'other-resource',
    });
    const params = {
      nextAuthSecret: TEST_JWT_SECRET,
      workerEnv: 'production',
      connectionString: 'postgres://test',
      audience: 'resource-audience',
    } as const;

    for (const testCase of [
      { token: matchingString.token, result: { userId: 'user-xyz-789' } },
      { token: arrayAudienceToken, result: { userId: 'user-xyz-789' } },
      { token: absentAudience.token, result: null },
      { token: mismatchedAudience.token, result: null },
    ]) {
      let lookupCount = 0;
      await expect(
        verifyKiloBearerAgainstCurrentPepper({
          ...params,
          token: testCase.token,
          getUserPepper: async (...args) => {
            lookupCount++;
            return getUserPepper(...args);
          },
        })
      ).resolves.toEqual(testCase.result);
      expect(lookupCount).toBe(testCase.result === null ? 0 : 1);
    }
  });

  it('applies required and legacy resource audience policies before account lookup', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
    });
    const params = {
      token,
      nextAuthSecret: TEST_JWT_SECRET,
      workerEnv: 'production',
      connectionString: 'postgres://test',
    };

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        ...params,
        getUserPepper,
        resourceAudience: { audience: 'resource-audience', mode: 'allow-legacy' },
      })
    ).resolves.toEqual({ userId: 'user-xyz-789' });
    let lookupCount = 0;
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        ...params,
        getUserPepper: async (...args) => {
          lookupCount++;
          return getUserPepper(...args);
        },
        resourceAudience: { audience: 'resource-audience', mode: 'required' },
      })
    ).resolves.toBeNull();
    expect(lookupCount).toBe(0);
  });

  it('compares present resource-token pepper claims against a non-null stored pepper', async () => {
    const tokens = await Promise.all([
      signKiloToken({
        userId: 'user-xyz-789',
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        env: 'production',
        audience: 'resource-audience',
      }),
      signKiloToken({
        userId: 'user-xyz-789',
        pepper: null,
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        env: 'production',
        audience: 'resource-audience',
      }),
      signKiloToken({
        userId: 'user-xyz-789',
        pepper: 'pepper-stale',
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        env: 'production',
        audience: 'resource-audience',
      }),
      signKiloToken({
        userId: 'user-xyz-789',
        pepper: 'pepper-current',
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        env: 'production',
        audience: 'resource-audience',
      }),
    ]);
    const params = {
      nextAuthSecret: TEST_JWT_SECRET,
      workerEnv: 'production',
      connectionString: 'postgres://test',
      getUserPepper,
      resourceAudience: { audience: 'resource-audience', mode: 'required' } as const,
    };

    for (const [token, result] of [
      [tokens[0]!.token, { userId: 'user-xyz-789' }],
      [tokens[1]!.token, null],
      [tokens[2]!.token, null],
      [tokens[3]!.token, { userId: 'user-xyz-789' }],
    ] as const) {
      await expect(verifyKiloBearerAgainstCurrentPepper({ ...params, token })).resolves.toEqual(
        result
      );
    }
  });

  it('denies missing and blocked resource-token accounts and never bypasses pepper checks', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-stale',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'resource-audience',
    });
    const params = {
      token,
      nextAuthSecret: TEST_JWT_SECRET,
      workerEnv: 'production',
      connectionString: 'postgres://test',
      resourceAudience: { audience: 'resource-audience', mode: 'required' } as const,
    };

    userResultByUserId.clear();
    await expect(
      verifyKiloBearerAgainstCurrentPepper({ ...params, getUserPepper })
    ).resolves.toBeNull();
    userResultByUserId.set('user-xyz-789', {
      pepper: 'pepper-current',
      blockedReason: 'manual block',
    });
    await expect(
      verifyKiloBearerAgainstCurrentPepper({ ...params, getUserPepper, allowBlocked: true })
    ).resolves.toBeNull();
    await expect(
      verifyKiloBearerAgainstCurrentPepper({ ...params, getUserPepper })
    ).resolves.toBeNull();
  });

  it('denies resource tokens with missing or mismatched env values when workerEnv is set', async () => {
    const tokens = await Promise.all([
      signKiloToken({
        userId: 'user-xyz-789',
        pepper: 'pepper-current',
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        audience: 'resource-audience',
      }),
      signKiloToken({
        userId: 'user-xyz-789',
        pepper: 'pepper-current',
        secret: TEST_JWT_SECRET,
        expiresInSeconds: 3600,
        env: 'staging',
        audience: 'resource-audience',
      }),
    ]);
    for (const { token } of tokens) {
      await expect(
        verifyKiloBearerAgainstCurrentPepper({
          token,
          nextAuthSecret: TEST_JWT_SECRET,
          workerEnv: 'production',
          connectionString: 'postgres://test',
          getUserPepper,
          resourceAudience: { audience: 'resource-audience', mode: 'required' },
        })
      ).resolves.toBeNull();
    }
  });

  it('propagates resource secret-provider failures without an account lookup', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: 'resource-audience',
    });
    let lookupCount = 0;

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: { get: async () => Promise.reject(new Error('secrets store unavailable')) },
        workerEnv: 'production',
        connectionString: 'postgres://test',
        getUserPepper: async (...args) => {
          lookupCount++;
          return getUserPepper(...args);
        },
        resourceAudience: { audience: 'resource-audience', mode: 'required' },
      })
    ).rejects.toThrow('secrets store unavailable');
    expect(lookupCount).toBe(0);
  });

  it('propagates account lookup failures after resource verification', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      audience: 'resource-audience',
    });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        nextAuthSecret: TEST_JWT_SECRET,
        connectionString: 'postgres://test',
        getUserPepper: async () => Promise.reject(new Error('connection refused')),
        resourceAudience: { audience: 'resource-audience', mode: 'required' },
      })
    ).rejects.toThrow('connection refused');
  });

  it('rejects mutually configured audience policies explicitly', async () => {
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token: null,
        nextAuthSecret: TEST_JWT_SECRET,
        connectionString: 'postgres://test',
        audience: 'legacy-audience',
        resourceAudience: { audience: 'resource-audience', mode: 'required' },
      } as never)
    ).rejects.toThrow('mutually exclusive');
  });
});

describe('internal service tokens (no apiTokenPepper, no env)', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userResultByUserId.clear();
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
  });

  async function signInternalToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      version: 3,
      kiloUserId: 'user-xyz-789',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));
  }

  function verifyInternalToken(token: string, workerEnv?: string) {
    return verifyKiloBearerAgainstCurrentPepper({
      token,
      nextAuthSecret: { get: async () => TEST_JWT_SECRET },
      ...(workerEnv ? { workerEnv } : {}),
      connectionString: 'postgres://test',
      getUserPepper,
    });
  }

  it('succeeds when workerEnv is omitted and the user is active', async () => {
    const token = await signInternalToken();

    await expect(verifyInternalToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('fails when workerEnv is provided', async () => {
    const token = await signInternalToken();

    await expect(verifyInternalToken(token, 'production')).resolves.toBeNull();
  });

  it('fails when blocked_reason is set', async () => {
    userResultByUserId.set('user-xyz-789', { pepper: null, blockedReason: 'manual block' });
    const token = await signInternalToken();

    await expect(verifyInternalToken(token)).resolves.toBeNull();
  });
});

describe('C15 deviceSessionId compatibility', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userResultByUserId.clear();
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blockedReason: null });
  });

  it('accepts a token carrying deviceSessionId claim', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      version: 3,
      kiloUserId: 'user-xyz-789',
      apiTokenPepper: 'pepper-current',
      env: 'production',
      tokenSource: 'kilo-chat',
      deviceSessionId: 'session-abc-123',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });
});
