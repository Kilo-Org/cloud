import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';
import { authenticateToken } from '../auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const currentPepperByUserId = vi.hoisted(() => new Map<string, string | null>());

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: currentPepperByUserId.get('user-xyz-789') }],
        }),
      }),
    }),
  }),
}));

function makeEnv(): Env {
  return {
    NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
    HYPERDRIVE: { connectionString: 'postgres://test' },
    WORKER_ENV: 'production',
  } as Env;
}

describe('authenticateToken', () => {
  beforeEach(() => {
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

    await expect(authenticateToken(token, makeEnv())).resolves.toEqual({ userId: 'user-xyz-789' });
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

    await expect(authenticateToken(token, makeEnv())).resolves.toEqual({
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

    await expect(authenticateToken(token, makeEnv())).resolves.toBeNull();
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

    await expect(authenticateToken(token, makeEnv())).resolves.toBeNull();
  });
});
