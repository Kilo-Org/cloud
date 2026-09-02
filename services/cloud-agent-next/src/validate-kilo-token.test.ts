import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';
import jwt from 'jsonwebtoken';
import { validateKiloToken } from './validate-kilo-token.js';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userRowByUserId = vi.hoisted(
  () => new Map<string, { pepper: string | null; blockedReason: string | null }>()
);
const getWorkerDb = vi.hoisted(() => vi.fn());
const dbFailure = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb,
}));

getWorkerDb.mockImplementation(() => ({
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          if (dbFailure.error) throw dbFailure.error;
          const row = userRowByUserId.get('user-1');
          if (!row) return [];
          return [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }];
        },
      }),
    }),
  }),
}));

function signResourceToken(
  claims: Record<string, unknown>,
  options: jwt.SignOptions = { algorithm: 'HS256', expiresIn: '1 hour' }
): string {
  return jwt.sign({ version: 3, kiloUserId: 'user-1', ...claims }, TEST_JWT_SECRET, options);
}

const validParams = { secret: TEST_JWT_SECRET, connectionString: 'postgres://test' };

describe('validateKiloToken', () => {
  beforeEach(() => {
    userRowByUserId.clear();
    getWorkerDb.mockClear();
    dbFailure.error = null;
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

  it('accepts legacy app-builder and cloud-agent tokens and forwards their original token', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });

    for (const tokenSource of ['app-builder', 'cloud-agent']) {
      const token = signResourceToken({ apiTokenPepper: 'pepper-current', tokenSource });
      await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toEqual({
        success: true,
        userId: 'user-1',
        token,
      });
    }
  });

  it('accepts matching cloud-agent-next audiences as a string or an array', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });

    for (const aud of ['cloud-agent-next', ['another-service', 'cloud-agent-next']]) {
      const token = signResourceToken({ apiTokenPepper: 'pepper-current', aud });
      await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toMatchObject({
        success: true,
        userId: 'user-1',
      });
    }
  });

  it('rejects non-target or malformed audiences before constructing a database client', async () => {
    const tokens = [
      signResourceToken({ aud: 'kilo-api' }),
      signResourceToken({ aud: 'kilo-gateway' }),
      signResourceToken({ aud: 'foreign-service' }),
      signResourceToken({ aud: [] }),
      signResourceToken({ aud: [null] }),
      signResourceToken({ aud: { audience: 'cloud-agent-next' } }),
    ];

    for (const token of tokens) {
      await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toEqual({
        success: false,
        error: 'Invalid or expired token',
      });
    }
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('preserves bot IDs and distinguishes absent, null, and stale pepper claims', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    const absentPepper = signResourceToken({ botId: 'bot-1', aud: 'cloud-agent-next' });
    const nullPepper = signResourceToken({ apiTokenPepper: null, aud: 'cloud-agent-next' });
    const stalePepper = signResourceToken({
      apiTokenPepper: 'pepper-stale',
      aud: 'cloud-agent-next',
    });

    await expect(validateKiloToken(`Bearer ${absentPepper}`, validParams)).resolves.toEqual({
      success: true,
      userId: 'user-1',
      token: absentPepper,
      botId: 'bot-1',
    });
    await expect(validateKiloToken(`Bearer ${nullPepper}`, validParams)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
    await expect(validateKiloToken(`Bearer ${stalePepper}`, validParams)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
  });

  it('accepts a null pepper only for an account with a null pepper', async () => {
    userRowByUserId.set('user-1', { pepper: null, blockedReason: null });
    const token = signResourceToken({ apiTokenPepper: null });

    await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toMatchObject({
      success: true,
      userId: 'user-1',
    });
  });

  it('skips the environment check when omitted and enforces it when supplied', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    const token = signResourceToken({ apiTokenPepper: 'pepper-current', env: 'production' });
    const tokenWithoutEnv = signResourceToken({ apiTokenPepper: 'pepper-current' });

    await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toMatchObject({
      success: true,
      userId: 'user-1',
    });
    await expect(
      validateKiloToken(`Bearer ${token}`, { ...validParams, workerEnv: 'production' })
    ).resolves.toMatchObject({ success: true, userId: 'user-1' });
    await expect(
      validateKiloToken(`Bearer ${token}`, { ...validParams, workerEnv: 'staging' })
    ).resolves.toEqual({ success: false, error: 'Invalid or expired token' });
    await expect(
      validateKiloToken(`Bearer ${tokenWithoutEnv}`, { ...validParams, workerEnv: 'production' })
    ).resolves.toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('accepts legacy tokens without dates through the resource verifier', async () => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    const token = signResourceToken(
      { apiTokenPepper: 'pepper-current', tokenSource: 'cloud-agent' },
      { algorithm: 'HS256', noTimestamp: true }
    );

    await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toMatchObject({
      success: true,
      userId: 'user-1',
    });
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

  it('rejects a missing user and propagates database failures after token verification', async () => {
    const token = signResourceToken({ apiTokenPepper: 'pepper-current' });

    await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });

    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    dbFailure.error = new Error('database unavailable');
    await expect(validateKiloToken(`Bearer ${token}`, validParams)).rejects.toThrow(
      'database unavailable'
    );
  });

  it.each([
    ['a malformed token', 'not-a-jwt'],
    ['a token with an invalid schema', signResourceToken({ version: 2 })],
    [
      'a token signed with another secret',
      jwt.sign({ version: 3, kiloUserId: 'user-1' }, 'other-secret'),
    ],
    [
      'an expired token',
      jwt.sign({ version: 3, kiloUserId: 'user-1' }, TEST_JWT_SECRET, { expiresIn: -1 }),
    ],
  ])('rejects %s', async (_description, token) => {
    userRowByUserId.set('user-1', { pepper: 'pepper-current', blockedReason: null });
    await expect(validateKiloToken(`Bearer ${token}`, validParams)).resolves.toEqual({
      success: false,
      error: 'Invalid or expired token',
    });
    expect(getWorkerDb).not.toHaveBeenCalled();
  });
});
