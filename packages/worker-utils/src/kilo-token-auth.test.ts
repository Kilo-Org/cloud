import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import { clearSecretCacheForTest } from './cached-secret';
import { KILO_TOKEN_MAX_LIFETIME_SECONDS, signKiloToken } from './kilo-token';
import {
  verifyKiloBearerAgainstCurrentPepper,
  verifyKiloBearerOrInternalAssertionAgainstCurrentPepper,
  type KiloUserPepperResult,
} from './kilo-token-auth';
import { signModernKiloToken } from './kilo-token-policy';

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
    keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
    acceptedIssuers: ['kilo-web'],
    workerEnv: 'production',
    connectionString: 'postgres://test',
    getUserPepper,
  });
}

describe('verifyKiloBearerAgainstCurrentPepper', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userResultByUserId.clear();
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blocked: false });
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
        keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
        acceptedIssuers: ['kilo-web'],
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
        keys: {
          legacyHs256Secret: {
            get: async () => {
              throw new Error('secrets store unavailable');
            },
          },
        },
        acceptedIssuers: ['kilo-web'],
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
        keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
        acceptedIssuers: ['kilo-web'],
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
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blocked: false });
    const { token } = await signToken({ pepper: null, tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('revokes a leaked user token when the pepper rotates from null to a value', async () => {
    userResultByUserId.set('user-xyz-789', { pepper: null, blocked: false });
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: KILO_TOKEN_MAX_LIFETIME_SECONDS,
      env: 'production',
    });
    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });

    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-rotated', blocked: false });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens for a blocked account when the pepper also matches', async () => {
    userResultByUserId.set('user-xyz-789', {
      pepper: 'pepper-current',
      blocked: true,
    });
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('rejects tokens for blocked users even when the stored pepper is null', async () => {
    userResultByUserId.set('user-xyz-789', {
      pepper: null,
      blocked: true,
    });
    const { token } = await signToken({ pepper: null, tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toBeNull();
  });

  it('accepts tokens for an unblocked account when the pepper matches', async () => {
    // Explicitly confirm the unblocked flag plus a matching pepper passes.
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blocked: false });
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(verifyToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('succeeds when a token with env is verified without workerEnv', async () => {
    const { token } = await signToken({ pepper: 'pepper-current', tokenSource: 'kilo-chat' });

    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token,
        keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
        acceptedIssuers: ['kilo-web'],
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
        keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
        acceptedIssuers: ['kilo-web'],
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
        keys: { legacyHs256Secret: TEST_JWT_SECRET },
        acceptedIssuers: ['kilo-web'],
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
      keys: { legacyHs256Secret: TEST_JWT_SECRET },
      acceptedIssuers: ['kilo-web'],
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
      keys: { legacyHs256Secret: TEST_JWT_SECRET },
      acceptedIssuers: ['kilo-web'] as const,
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

  it('requires a current resource-token pepper claim against a non-null stored pepper', async () => {
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
      keys: { legacyHs256Secret: TEST_JWT_SECRET },
      acceptedIssuers: ['kilo-web'] as const,
      workerEnv: 'production',
      connectionString: 'postgres://test',
      getUserPepper,
      resourceAudience: { audience: 'resource-audience', mode: 'required' } as const,
    };

    for (const [token, result] of [
      [tokens[0]!.token, null],
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
      keys: { legacyHs256Secret: TEST_JWT_SECRET },
      acceptedIssuers: ['kilo-web'] as const,
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
      blocked: true,
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
          keys: { legacyHs256Secret: TEST_JWT_SECRET },
          acceptedIssuers: ['kilo-web'],
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
        keys: {
          legacyHs256Secret: {
            get: async () => Promise.reject(new Error('secrets store unavailable')),
          },
        },
        acceptedIssuers: ['kilo-web'],
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
        keys: { legacyHs256Secret: TEST_JWT_SECRET },
        acceptedIssuers: ['kilo-web'],
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
        keys: { legacyHs256Secret: TEST_JWT_SECRET },
        acceptedIssuers: ['kilo-web'],
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
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blocked: false });
  });

  async function signInternalToken(
    options: { lifetimeSeconds?: number; issuedAt?: boolean; issuedAtOffsetSeconds?: number } = {}
  ): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000) + (options.issuedAtOffsetSeconds ?? 0);
    const signer = new SignJWT({
      version: 3,
      kiloUserId: 'user-xyz-789',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? 3600));
    return (options.issuedAt === false ? signer : signer.setIssuedAt(issuedAt)).sign(
      new TextEncoder().encode(TEST_JWT_SECRET)
    );
  }

  async function signModernInternalToken(issuedAtOffsetSeconds = 0): Promise<string> {
    const { token } = await signModernKiloToken({
      userId: 'user-xyz-789',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      audience: 'session-ingest',
      tokenPurpose: 'internal-service',
      credentialExchange: false,
      now: new Date(Date.now() + issuedAtOffsetSeconds * 1000),
    });
    return token;
  }

  function verifyInternalToken(token: string, workerEnv?: string) {
    return verifyKiloBearerOrInternalAssertionAgainstCurrentPepper({
      token,
      keys: { legacyHs256Secret: { get: async () => TEST_JWT_SECRET } },
      acceptedIssuers: ['kilo-web'],
      ...(workerEnv ? { workerEnv } : {}),
      connectionString: 'postgres://test',
      getUserPepper,
    });
  }

  function verifyModernInternalToken(token: string) {
    return verifyKiloBearerOrInternalAssertionAgainstCurrentPepper({
      token,
      keys: { legacyHs256Secret: TEST_JWT_SECRET },
      acceptedIssuers: ['kilo-web'],
      connectionString: 'postgres://test',
      getUserPepper,
      resourceAudience: { audience: 'session-ingest', mode: 'allow-legacy' },
    });
  }

  it('succeeds when workerEnv is omitted and the user is active', async () => {
    const token = await signInternalToken();

    await expect(verifyInternalToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('accepts a modern audience-bound internal-service assertion without a pepper claim', async () => {
    const token = await signModernInternalToken();

    await expect(verifyModernInternalToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('refuses legacy and modern claimless assertions at the user-credential verifier', async () => {
    const legacy = await signInternalToken({ lifetimeSeconds: 300 });
    const modern = await signModernInternalToken();

    await expect(verifyToken(legacy)).resolves.toBeNull();
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token: modern,
        keys: { legacyHs256Secret: TEST_JWT_SECRET },
        acceptedIssuers: ['kilo-web'],
        connectionString: 'postgres://test',
        getUserPepper,
        resourceAudience: { audience: 'session-ingest', mode: 'allow-legacy' },
      })
    ).resolves.toBeNull();
    userResultByUserId.set('user-xyz-789', { pepper: null, blocked: false });
    await expect(
      verifyKiloBearerAgainstCurrentPepper({
        token: legacy,
        keys: { legacyHs256Secret: TEST_JWT_SECRET },
        acceptedIssuers: ['kilo-web'],
        connectionString: 'postgres://test',
        getUserPepper,
      })
    ).resolves.toBeNull();
  });

  it('rejects a claimless token that lives longer than one hour for an account with a pepper', async () => {
    const token = await signInternalToken({ lifetimeSeconds: 157_680_000 });

    await expect(verifyInternalToken(token)).resolves.toBeNull();
  });

  it('rejects a claimless long-lived token for an account without a pepper', async () => {
    userResultByUserId.set('user-xyz-789', { pepper: null, blocked: false });
    const token = await signInternalToken({ lifetimeSeconds: 3601 });

    await expect(verifyInternalToken(token)).resolves.toBeNull();
  });

  it('rejects a claimless token without an issue time', async () => {
    const token = await signInternalToken({ issuedAt: false, lifetimeSeconds: 300 });

    await expect(verifyInternalToken(token)).resolves.toBeNull();
  });

  it('rejects legacy and modern claimless assertions issued more than a minute ahead', async () => {
    const legacy = await signInternalToken({ lifetimeSeconds: 300, issuedAtOffsetSeconds: 120 });
    const modern = await signModernInternalToken(3000);

    await expect(verifyInternalToken(legacy)).resolves.toBeNull();
    await expect(verifyModernInternalToken(modern)).resolves.toBeNull();
  });

  it('accepts a claimless assertion issued within the clock-skew allowance', async () => {
    const token = await signInternalToken({ lifetimeSeconds: 300, issuedAtOffsetSeconds: 30 });

    await expect(verifyInternalToken(token)).resolves.toEqual({ userId: 'user-xyz-789' });
  });

  it('fails when workerEnv is provided', async () => {
    const token = await signInternalToken();

    await expect(verifyInternalToken(token, 'production')).resolves.toBeNull();
  });

  it('fails when blocked_reason is set', async () => {
    userResultByUserId.set('user-xyz-789', { pepper: null, blocked: true });
    const token = await signInternalToken();

    await expect(verifyInternalToken(token)).resolves.toBeNull();
  });
});

describe('C15 deviceSessionId compatibility', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userResultByUserId.clear();
    userResultByUserId.set('user-xyz-789', { pepper: 'pepper-current', blocked: false });
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
