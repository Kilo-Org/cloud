import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify, SignJWT } from 'jose';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { getWorkerDb } from '@kilocode/db/client';
import {
  SESSION_SHARE_TOKEN_AUDIENCE,
  SESSION_SHARE_TOKEN_ISSUER,
  SESSION_SHARE_TOKEN_MAX_TTL_SECONDS,
  SESSION_SHARE_TOKEN_TTL_SECONDS,
  SESSION_SHARE_TOKEN_VERSION,
  resolveSessionShareToken,
  signSessionShareToken,
  verifySessionShareToken,
  type SessionShareTokenEnv,
  type SessionShareTokenOptions,
} from './session-share-token';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

const SECRET = 'session-share-secret-for-tests-32-bytes';
const SESSION_ID = 'ses_12345678901234567890123456';
const PUBLIC_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-19T10:00:00.000Z');
const NOW_MS = NOW.getTime();
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const FIXED_CLOCK: SessionShareTokenOptions = { now: () => NOW };

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

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: SESSION_SHARE_TOKEN_ISSUER,
    aud: SESSION_SHARE_TOKEN_AUDIENCE,
    version: SESSION_SHARE_TOKEN_VERSION,
    sub: SESSION_ID,
    jti: PUBLIC_ID,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + SESSION_SHARE_TOKEN_TTL_SECONDS,
    shared_at: NOW_MS,
    ...overrides,
  };
}

describe('session share tokens', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('signs a finite lifetime and the exact purpose-bound claims', async () => {
    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );

    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
      algorithms: ['HS256'],
      currentDate: NOW,
    });

    expect(protectedHeader).toEqual({ alg: 'HS256' });
    expect(payload).toEqual({
      iss: SESSION_SHARE_TOKEN_ISSUER,
      aud: SESSION_SHARE_TOKEN_AUDIENCE,
      version: SESSION_SHARE_TOKEN_VERSION,
      sub: SESSION_ID,
      jti: PUBLIC_ID,
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + SESSION_SHARE_TOKEN_TTL_SECONDS,
      shared_at: NOW_MS,
    });
    await expect(verifySessionShareToken(makeEnv(), token, FIXED_CLOCK)).resolves.toEqual(payload);
  });

  it.each([
    ['wrong secret', async () => signPayload(validPayload(), { secret: 'wrong-secret' })],
    ['non-HS256 algorithm', async () => signPayload(validPayload(), { alg: 'HS384' })],
    ['wrong issuer', async () => signPayload(validPayload({ iss: 'another-service' }))],
    ['wrong audience', async () => signPayload(validPayload({ aud: 'ordinary-kilo-token' }))],
    ['unknown version', async () => signPayload(validPayload({ version: 2 }))],
    ['malformed subject', async () => signPayload(validPayload({ sub: 'ses_bad' }))],
    ['malformed generation id', async () => signPayload(validPayload({ jti: 'not-a-uuid' }))],
    ['empty generation id', async () => signPayload(validPayload({ jti: '' }))],
    [
      'missing generation id',
      async () => {
        const payload = validPayload();
        delete payload.jti;
        return signPayload(payload);
      },
    ],
    [
      'missing iat',
      async () => {
        const payload = validPayload();
        delete payload.iat;
        return signPayload(payload);
      },
    ],
    [
      'legacy token without exp',
      async () => {
        const payload = validPayload();
        delete payload.exp;
        return signPayload(payload);
      },
    ],
    [
      'legacy token without shared_at',
      async () => {
        const payload = validPayload();
        delete payload.shared_at;
        return signPayload(payload);
      },
    ],
    ['non-positive lifetime', async () => signPayload(validPayload({ exp: NOW_SECONDS }))],
    [
      'lifetime beyond the accepted maximum',
      async () =>
        signPayload(validPayload({ exp: NOW_SECONDS + SESSION_SHARE_TOKEN_MAX_TTL_SECONDS + 1 })),
    ],
    [
      'shared_at outside the issued second',
      async () => signPayload(validPayload({ shared_at: NOW_MS + 1000 })),
    ],
    ['unexpected payload claim', async () => signPayload(validPayload({ token: 'ordinary' }))],
  ])('rejects %s tokens', async (_description, createToken) => {
    await expect(
      verifySessionShareToken(makeEnv(), await createToken(), FIXED_CLOCK)
    ).resolves.toBeNull();
  });

  it('accepts a token until its expiry instant and rejects it afterwards', async () => {
    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );
    const expiresAtMs = (NOW_SECONDS + SESSION_SHARE_TOKEN_TTL_SECONDS) * 1000;

    await expect(
      verifySessionShareToken(makeEnv(), token, {
        now: () => new Date(expiresAtMs - 1),
      })
    ).resolves.toMatchObject({ jti: PUBLIC_ID });
    await expect(
      verifySessionShareToken(makeEnv(), token, {
        now: () => new Date(expiresAtMs),
      })
    ).resolves.toBeNull();
    await expect(
      verifySessionShareToken(makeEnv(), token, {
        now: () => new Date(expiresAtMs + 1000),
      })
    ).resolves.toBeNull();
  });

  it('rejects a token below the global iat cutoff', async () => {
    const token = await signPayload(validPayload());

    await expect(
      verifySessionShareToken(makeEnv(String(NOW_SECONDS + 1)), token, FIXED_CLOCK)
    ).resolves.toBeNull();
  });

  it('accepts tokens at or above the global iat cutoff', async () => {
    const token = await signPayload(validPayload());

    await expect(
      verifySessionShareToken(makeEnv(String(NOW_SECONDS)), token, FIXED_CLOCK)
    ).resolves.toEqual(validPayload());
    await expect(
      verifySessionShareToken(makeEnv(String(NOW_SECONDS - 1)), token, FIXED_CLOCK)
    ).resolves.toEqual(validPayload());
  });

  it.each(['', '-1', '1.5', '1e3', '9007199254740992', 'not-a-number'])(
    'fails closed for malformed cutoff %s',
    async minIat => {
      const token = await signPayload(validPayload());
      await expect(verifySessionShareToken(makeEnv(minIat), token, FIXED_CLOCK)).rejects.toThrow(
        'SESSION_SHARE_TOKEN_MIN_IAT is misconfigured'
      );
    }
  );

  it('does not query the database for an invalid token', async () => {
    await expect(resolveSessionShareToken(makeEnv(), 'not-a-jwt')).resolves.toBeNull();
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('does not query the database for an expired token', async () => {
    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );

    await expect(
      resolveSessionShareToken(makeEnv(), token, {
        now: () => new Date(NOW_MS + (SESSION_SHARE_TOKEN_TTL_SECONDS + 1) * 1000),
      })
    ).resolves.toBeNull();
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('resolves only the current session generation and returns the content cutoff', async () => {
    const selectResult = vi.fn(async () => [
      {
        sessionId: SESSION_ID,
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        gitUrl: 'https://github.com/owner/repo',
        gitBranch: 'main',
        createdAt: '2026-08-19T10:00:00.000Z',
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

    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );

    await expect(resolveSessionShareToken(makeEnv(), token, FIXED_CLOCK)).resolves.toEqual({
      sessionId: SESSION_ID,
      publicId: PUBLIC_ID,
      kiloUserId: 'usr_123',
      title: 'Shared title',
      ownerName: 'Shared owner',
      gitUrl: 'https://github.com/owner/repo',
      gitBranch: 'main',
      createdAt: '2026-08-19T10:00:00.000Z',
      contentCutoffMs: NOW_MS,
    });
    expect(selectResult).toHaveBeenCalledTimes(1);
  });

  it('gates organization shares on a live membership', async () => {
    const select = {
      from: vi.fn(() => select),
      leftJoin: vi.fn((_table: unknown, _condition?: unknown) => select),
      where: vi.fn((_condition: unknown) => select),
      limit: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve([])),
    };
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => select) } as never);

    const token = await signSessionShareToken(makeEnv(), {
      sessionId: SESSION_ID,
      publicId: PUBLIC_ID,
    });

    await expect(resolveSessionShareToken(makeEnv(), token)).resolves.toBeNull();
    const condition = select.where.mock.calls[0]?.[0];
    if (!(condition instanceof SQL)) {
      throw new Error('Expected where condition');
    }
    const generated = new PgDialect().sqlToQuery(condition);
    expect(generated.sql).toMatch(/"organizations"\."deleted_at" is null/i);
    expect(generated.sql).toMatch(/"organization_memberships"\."id" is not null/i);
    const joinSql = select.leftJoin.mock.calls
      .map(([, joinCondition]) => new PgDialect().sqlToQuery(joinCondition as SQL).sql)
      .join(' ');
    expect(joinSql).toMatch(/"organization_memberships"\."kilo_user_id"/i);
  });

  it('matches the session public_id to the token generation', async () => {
    let whereCondition: unknown;
    const select = {
      from: vi.fn(() => select),
      leftJoin: vi.fn(() => select),
      where: vi.fn((condition: unknown) => {
        whereCondition = condition;
        return select;
      }),
      limit: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve([])),
    };
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => select) } as never);

    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );
    await expect(resolveSessionShareToken(makeEnv(), token, FIXED_CLOCK)).resolves.toBeNull();

    if (!(whereCondition instanceof SQL)) {
      throw new Error('Expected a SQL generation predicate');
    }
    const rendered = new PgDialect().sqlToQuery(whereCondition);
    const sql = rendered.sql.toLowerCase();
    expect(sql).toContain('"cli_sessions_v2"."public_id" is not null');
    expect(sql).toContain('"cli_sessions_v2"."public_id" = $2');
    expect(rendered.params).toEqual([SESSION_ID, PUBLIC_ID]);
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

    const token = await signSessionShareToken(
      makeEnv(),
      { sessionId: SESSION_ID, publicId: PUBLIC_ID },
      FIXED_CLOCK
    );

    await expect(resolveSessionShareToken(makeEnv(), token, FIXED_CLOCK)).rejects.toThrow(
      'database unavailable'
    );
  });
});
