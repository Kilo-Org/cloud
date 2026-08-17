import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';

import { getWorkerDb } from '@kilocode/db/client';
import {
  SESSION_SHARE_TOKEN_AUDIENCE,
  SESSION_SHARE_TOKEN_ISSUER,
  SESSION_SHARE_TOKEN_VERSION,
  resolveSessionShareToken,
  signSessionShareToken,
  verifySessionShareToken,
  type SessionShareTokenEnv,
} from './session-share-token';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

const SECRET = 'session-share-secret-for-tests-32-bytes';
const SESSION_ID = 'ses_12345678901234567890123456';
const PUBLIC_ID = '11111111-1111-4111-8111-111111111111';

function makeEnv(minIat = '0'): SessionShareTokenEnv {
  return {
    SESSION_SHARE_JWT_SECRET_PROD: { get: async () => SECRET },
    SESSION_SHARE_TOKEN_MIN_IAT: minIat,
    HYPERDRIVE: { connectionString: 'postgres://test' },
  };
}

async function signPayload(
  payload: Record<string, unknown>,
  options: { secret?: string; alg?: 'HS256' | 'HS384' } = {}
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .sign(new TextEncoder().encode(options.secret ?? SECRET));
}

function validPayload(iat = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return {
    iss: SESSION_SHARE_TOKEN_ISSUER,
    aud: SESSION_SHARE_TOKEN_AUDIENCE,
    version: SESSION_SHARE_TOKEN_VERSION,
    sub: SESSION_ID,
    jti: PUBLIC_ID,
    iat,
  };
}

describe('session share tokens', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('signs and verifies the exact purpose-bound claims without exp', async () => {
    const token = await signSessionShareToken(makeEnv(), {
      sessionId: SESSION_ID,
      publicId: PUBLIC_ID,
    });

    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      algorithms: ['HS256'],
    });

    expect(protectedHeader).toEqual({ alg: 'HS256' });
    expect(payload).toEqual({
      iss: SESSION_SHARE_TOKEN_ISSUER,
      aud: SESSION_SHARE_TOKEN_AUDIENCE,
      version: SESSION_SHARE_TOKEN_VERSION,
      sub: SESSION_ID,
      jti: PUBLIC_ID,
      iat: payload.iat,
    });
    expect(payload).not.toHaveProperty('exp');
    await expect(verifySessionShareToken(makeEnv(), token)).resolves.toEqual(payload);
  });

  it.each([
    ['wrong secret', async () => signPayload(validPayload(), { secret: 'wrong-secret' })],
    ['non-HS256 algorithm', async () => signPayload(validPayload(), { alg: 'HS384' })],
    ['wrong issuer', async () => signPayload({ ...validPayload(), iss: 'another-service' })],
    ['wrong audience', async () => signPayload({ ...validPayload(), aud: 'ordinary-kilo-token' })],
    ['unknown version', async () => signPayload({ ...validPayload(), version: 2 })],
    ['malformed subject', async () => signPayload({ ...validPayload(), sub: 'ses_bad' })],
    ['malformed generation id', async () => signPayload({ ...validPayload(), jti: 'not-a-uuid' })],
    [
      'missing iat',
      async () => {
        const payload = validPayload();
        delete payload.iat;
        return signPayload(payload);
      },
    ],
    ['unexpected exp', async () => signPayload({ ...validPayload(), exp: 9_999_999_999 })],
    ['unexpected payload claim', async () => signPayload({ ...validPayload(), token: 'ordinary' })],
  ])('rejects %s tokens', async (_description, createToken) => {
    await expect(verifySessionShareToken(makeEnv(), await createToken())).resolves.toBeNull();
  });

  it('rejects a token one second below the cutoff', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signPayload(validPayload(now));

    await expect(verifySessionShareToken(makeEnv(String(now + 1)), token)).resolves.toBeNull();
  });

  it('accepts a token equal to the cutoff', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signPayload(validPayload(now));

    await expect(verifySessionShareToken(makeEnv(String(now)), token)).resolves.toEqual(
      validPayload(now)
    );
  });

  it('accepts a token above the cutoff', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signPayload(validPayload(now + 1));

    await expect(verifySessionShareToken(makeEnv(String(now)), token)).resolves.toEqual(
      validPayload(now + 1)
    );
  });

  it.each(['', '-1', '1.5', '1e3', '9007199254740992', 'not-a-number'])(
    'fails closed for malformed cutoff %s',
    async minIat => {
      const token = await signPayload(validPayload());
      await expect(verifySessionShareToken(makeEnv(minIat), token)).rejects.toThrow(
        'SESSION_SHARE_TOKEN_MIN_IAT is misconfigured'
      );
    }
  );

  it('does not query the database for an invalid token', async () => {
    await expect(verifySessionShareToken(makeEnv(), 'not-a-jwt')).resolves.toBeNull();
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('resolves only the current session generation and returns metadata', async () => {
    const selectResult = vi.fn(async () => [
      {
        sessionId: SESSION_ID,
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
      },
    ]);
    const select = {
      from: vi.fn(() => select),
      leftJoin: vi.fn(() => select),
      where: vi.fn(() => select),
      limit: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve(selectResult())),
    };
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => select) } as never);

    const token = await signSessionShareToken(makeEnv(), {
      sessionId: SESSION_ID,
      publicId: PUBLIC_ID,
    });

    await expect(resolveSessionShareToken(makeEnv(), token)).resolves.toEqual({
      sessionId: SESSION_ID,
      kiloUserId: 'usr_123',
      title: 'Shared title',
      ownerName: 'Shared owner',
    });
    expect(selectResult).toHaveBeenCalledTimes(1);
  });

  it('propagates database failures as operational errors', async () => {
    const select = {
      from: vi.fn(() => select),
      leftJoin: vi.fn(() => select),
      where: vi.fn(() => select),
      limit: vi.fn(() => select),
      then: vi.fn((_resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        reject(new Error('database unavailable'))
      ),
    };
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => select) } as never);

    const token = await signSessionShareToken(makeEnv(), {
      sessionId: SESSION_ID,
      publicId: PUBLIC_ID,
    });

    await expect(resolveSessionShareToken(makeEnv(), token)).rejects.toThrow(
      'database unavailable'
    );
  });
});
