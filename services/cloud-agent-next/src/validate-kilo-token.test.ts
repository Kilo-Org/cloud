import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';
import { validateKiloToken } from './validate-kilo-token.js';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userRowByUserId = vi.hoisted(
  () => new Map<string, { pepper: string | null; blockedReason: string | null }>()
);

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const row = userRowByUserId.get('user-1');
            if (!row) return [];
            return [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }];
          },
        }),
      }),
    }),
  }),
}));

describe('validateKiloToken', () => {
  beforeEach(() => {
    userRowByUserId.clear();
  });

  it('returns a configuration error when NEXTAUTH_SECRET is missing', async () => {
    await expect(
      validateKiloToken('Bearer token', { secret: null, connectionString: 'postgres://test' })
    ).resolves.toEqual({
      success: false,
      error: 'NEXTAUTH_SECRET is not configured on the worker',
    });
  });

  it('returns an error when the Authorization header is missing or malformed', async () => {
    await expect(
      validateKiloToken(null, { secret: TEST_JWT_SECRET, connectionString: 'postgres://test' })
    ).resolves.toEqual({
      success: false,
      error: 'Missing or malformed Authorization header',
    });
  });

  it('accepts a token for an active account with the current pepper', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
    });

    await expect(
      validateKiloToken(`Bearer ${token}`, {
        secret: TEST_JWT_SECRET,
        connectionString: 'postgres://test',
      })
    ).resolves.toMatchObject({ success: true, userId: 'user-1', token });
  });

  it('rejects a token with a stale pepper', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-stale',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
    });

    await expect(
      validateKiloToken(`Bearer ${token}`, {
        secret: TEST_JWT_SECRET,
        connectionString: 'postgres://test',
      })
    ).resolves.toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('rejects a token for a blocked account', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: 'manual block' });
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
    });

    await expect(
      validateKiloToken(`Bearer ${token}`, {
        secret: TEST_JWT_SECRET,
        connectionString: 'postgres://test',
      })
    ).resolves.toEqual({ success: false, error: 'Invalid or expired token' });
  });
});
