import { createHmac } from 'node:crypto';
import { KILO_TOKEN_VERSION, signKiloToken, verifyKiloToken } from '@kilocode/worker-utils';
import { describe, expect, it, vi } from 'vitest';
import { authenticateIsolateReviewRequest } from '../../src/auth';

const baseOptions = {
  internalApiKey: 'internal-secret',
  expectedInternalApiKey: 'internal-secret',
  authorization: 'Bearer kilo-jwt',
  nextAuthSecret: 'next-auth-secret',
  workerEnv: 'production',
  connectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
};

async function verifyBearerWithCurrentPepper(
  params: Parameters<
    NonNullable<Parameters<typeof authenticateIsolateReviewRequest>[0]['verifyBearer']>
  >[0]
) {
  if (!params.token) return null;
  const payload = await verifyKiloToken(params.token, params.nextAuthSecret);
  if (payload.env !== params.workerEnv) return null;
  if (params.requirePepper && payload.apiTokenPepper === undefined) return null;
  if (payload.apiTokenPepper !== 'pepper-current') return null;
  if (
    params.requiredTokenSource !== undefined &&
    payload.tokenSource !== params.requiredTokenSource
  ) {
    return null;
  }
  if (
    params.maxTokenLifetimeSeconds !== undefined &&
    (payload.exp === undefined ||
      payload.iat === undefined ||
      payload.exp - payload.iat > params.maxTokenLifetimeSeconds)
  ) {
    return null;
  }
  return { userId: payload.kiloUserId };
}

function signInternalServiceToken(
  userId: string,
  claims: { env?: string; tokenSource?: string; exp?: number } = {}
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      version: KILO_TOKEN_VERSION,
      kiloUserId: userId,
      iat: now,
      exp: now + 3600,
      ...claims,
    })
  ).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', baseOptions.nextAuthSecret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

describe('isolate-review request authentication', () => {
  it('requires the internal API key before inspecting the customer token', async () => {
    const verifyBearer = vi.fn();

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        internalApiKey: 'wrong-secret',
        verifyBearer,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or missing internal API key',
    });
    expect(verifyBearer).not.toHaveBeenCalled();
  });

  it('requires a Kilo bearer after the internal key is accepted', async () => {
    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: undefined,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Missing or malformed Authorization header',
    });
  });

  it('returns the authenticated user, original token, and verified expiry', async () => {
    const verifyBearer = vi.fn().mockResolvedValue({ userId: 'user-1' });
    const { token, expiresAt } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 90,
      env: 'production',
      extra: { tokenSource: 'isolate-review' },
    });

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer,
      })
    ).resolves.toEqual({
      success: true,
      userId: 'user-1',
      token,
      credentialsExpireAt: Date.parse(expiresAt),
    });
    expect(verifyBearer).toHaveBeenCalledWith({
      token,
      nextAuthSecret: 'next-auth-secret',
      workerEnv: baseOptions.workerEnv,
      requirePepper: true,
      requiredTokenSource: 'isolate-review',
      maxTokenLifetimeSeconds: 3600,
      connectionString: baseOptions.connectionString,
    });
  });

  it('accepts a one-hour isolate-review bearer in production', async () => {
    const { token, expiresAt } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 3600,
      env: baseOptions.workerEnv,
      extra: { tokenSource: 'isolate-review' },
    });

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer: verifyBearerWithCurrentPepper,
      })
    ).resolves.toEqual({
      success: true,
      userId: 'user-1',
      token,
      credentialsExpireAt: Date.parse(expiresAt),
    });
  });

  it('accepts a one-day bearer without a token source outside production', async () => {
    const { token, expiresAt } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 24 * 60 * 60,
      env: 'development',
    });
    const verifyBearer = vi.fn(verifyBearerWithCurrentPepper);

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        workerEnv: 'development',
        verifyBearer,
      })
    ).resolves.toEqual({
      success: true,
      userId: 'user-1',
      token,
      credentialsExpireAt: Date.parse(expiresAt),
    });
    expect(verifyBearer).toHaveBeenCalledWith({
      token,
      nextAuthSecret: baseOptions.nextAuthSecret,
      workerEnv: 'development',
      requirePepper: true,
      connectionString: baseOptions.connectionString,
    });
  });

  it.each([{ tokenSource: 'cloud-agent' }, { tokenSource: undefined }])(
    'rejects a production bearer with tokenSource $tokenSource',
    async ({ tokenSource }) => {
      const { token } = await signKiloToken({
        userId: 'user-1',
        pepper: 'pepper-current',
        secret: baseOptions.nextAuthSecret,
        expiresInSeconds: 3600,
        env: baseOptions.workerEnv,
        ...(tokenSource === undefined ? {} : { extra: { tokenSource } }),
      });

      await expect(
        authenticateIsolateReviewRequest({
          ...baseOptions,
          authorization: `Bearer ${token}`,
          verifyBearer: verifyBearerWithCurrentPepper,
        })
      ).resolves.toEqual({
        success: false,
        status: 401,
        error: 'Invalid or expired Kilo token',
      });
    }
  );

  it('rejects a production isolate-review bearer valid for more than one hour', async () => {
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 3601,
      env: baseOptions.workerEnv,
      extra: { tokenSource: 'isolate-review' },
    });

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer: verifyBearerWithCurrentPepper,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired Kilo token',
    });
  });

  it('rejects a customer bearer minted for another environment', async () => {
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 3600,
      env: 'development',
      extra: { tokenSource: 'isolate-review' },
    });

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer: verifyBearerWithCurrentPepper,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired Kilo token',
    });
  });

  it('rejects an internal-service bearer without environment and pepper claims', async () => {
    const token = signInternalServiceToken('user-1');

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer: verifyBearerWithCurrentPepper,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired Kilo token',
    });
  });

  it.each(['production', 'development'])(
    'rejects a matching-environment bearer without a pepper claim in %s',
    async workerEnv => {
      const token = signInternalServiceToken('user-1', {
        env: workerEnv,
        ...(workerEnv === 'production' ? { tokenSource: 'isolate-review' } : {}),
      });

      await expect(
        authenticateIsolateReviewRequest({
          ...baseOptions,
          authorization: `Bearer ${token}`,
          workerEnv,
          verifyBearer: verifyBearerWithCurrentPepper,
        })
      ).resolves.toEqual({
        success: false,
        status: 401,
        error: 'Invalid or expired Kilo token',
      });
    }
  );

  it('rejects a customer bearer signed before its current pepper', async () => {
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-stale',
      secret: baseOptions.nextAuthSecret,
      expiresInSeconds: 3600,
      env: baseOptions.workerEnv,
      extra: { tokenSource: 'isolate-review' },
    });

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        authorization: `Bearer ${token}`,
        verifyBearer: verifyBearerWithCurrentPepper,
      })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired Kilo token',
    });
  });

  it('rejects an invalid Kilo bearer without exposing verification details', async () => {
    const verifyBearer = vi.fn().mockResolvedValue(null);

    await expect(
      authenticateIsolateReviewRequest({ ...baseOptions, verifyBearer })
    ).resolves.toEqual({
      success: false,
      status: 401,
      error: 'Invalid or expired Kilo token',
    });
  });

  it.each([undefined, 0, -1, 1e20])(
    'rejects an absent, expired, or unbounded verified expiry: %s',
    async exp => {
      const token = signInternalServiceToken('user-1', { env: 'development', exp });
      await expect(
        authenticateIsolateReviewRequest({
          ...baseOptions,
          workerEnv: 'development',
          authorization: `Bearer ${token}`,
          verifyBearer: async () => ({ userId: 'user-1' }),
        })
      ).resolves.toEqual({ success: false, status: 401, error: 'Invalid or expired Kilo token' });
    }
  );

  it('does not accept unsigned expiry claims or a different verified identity', async () => {
    const token = signInternalServiceToken('user-1', { env: 'development' });
    for (const [authorization, userId] of [
      [`Bearer ${token.slice(0, -10)}AAAAAAAAAA`, 'user-1'],
      [`Bearer ${token}`, 'different-user'],
    ]) {
      await expect(
        authenticateIsolateReviewRequest({
          ...baseOptions,
          authorization,
          workerEnv: 'development',
          verifyBearer: async () => ({ userId }),
        })
      ).resolves.toEqual({ success: false, status: 401, error: 'Invalid or expired Kilo token' });
    }
  });

  it('maps verification outages to a retryable response', async () => {
    const verifyBearer = vi.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(
      authenticateIsolateReviewRequest({ ...baseOptions, verifyBearer })
    ).resolves.toEqual({
      success: false,
      status: 503,
      error: 'Kilo token verification is temporarily unavailable',
    });
  });

  it('fails closed when the worker environment is not configured', async () => {
    const verifyBearer = vi.fn();

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        workerEnv: undefined,
        verifyBearer,
      })
    ).resolves.toEqual({
      success: false,
      status: 500,
      error: 'Kilo token verification is not configured on the worker',
    });
    expect(verifyBearer).not.toHaveBeenCalled();
  });

  it('fails closed when the worker has no internal secret', async () => {
    const verifyBearer = vi.fn();

    await expect(
      authenticateIsolateReviewRequest({
        ...baseOptions,
        expectedInternalApiKey: undefined,
        verifyBearer,
      })
    ).resolves.toEqual({
      success: false,
      status: 500,
      error: 'Internal API secret is not configured on the worker',
    });
    expect(verifyBearer).not.toHaveBeenCalled();
  });
});
