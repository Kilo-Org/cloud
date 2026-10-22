import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./dos/SessionAccessCacheDO', () => ({
  SessionAccessCacheDO: class SessionAccessCacheDO {},
  getSessionAccessCacheDO: vi.fn(),
}));

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { app } from './index';
import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { signSessionShareToken } from './services/session-share-token';

type TestBindings = {
  HYPERDRIVE: { connectionString: string };
  SESSION_INGEST_DO: unknown;
  SESSION_ACCESS_CACHE_DO: unknown;
  NEXTAUTH_SECRET: unknown;
  NEXTAUTH_SECRET_RAW?: string;
  INTERNAL_API_SECRET_PROD: { get(): Promise<string> };
  SESSION_SHARE_JWT_SECRET_PROD: { get(): Promise<string> };
  SESSION_SHARE_TOKEN_MIN_IAT: string;
};

function makeDbFakes() {
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  let whereCondition: unknown;
  const select = {
    from: vi.fn(() => select),
    leftJoin: vi.fn(() => select),
    where: vi.fn((condition: unknown) => {
      whereCondition = condition;
      return select;
    }),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  const db = {
    select: vi.fn(() => select),
  };

  return { db, selectResult, selectCondition: () => whereCondition };
}

const defaultEnv: TestBindings = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
  SESSION_INGEST_DO: {},
  SESSION_ACCESS_CACHE_DO: {},
  NEXTAUTH_SECRET: {},
  NEXTAUTH_SECRET_RAW: 'secret',
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
  SESSION_SHARE_JWT_SECRET_PROD: {
    get: async () => 'session-share-secret-for-tests-32-bytes',
  },
  SESSION_SHARE_TOKEN_MIN_IAT: '0',
};

describe('session access invalidation route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects invalidation without the internal secret', async () => {
    const cache = { invalidateOrganization: vi.fn(async () => undefined) };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      cache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const res = await app.request(
      '/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kiloUserId: 'usr_removed',
          organizationId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      defaultEnv
    );

    expect(res.status).toBe(401);
    expect(cache.invalidateOrganization).not.toHaveBeenCalled();
    expect(getUserConnectionDO).not.toHaveBeenCalled();
  });

  it.each(['wrong-secretxxx', 'wrong'])(
    'rejects invalidation with an incorrect internal secret: %s',
    async secret => {
      const cache = { invalidateOrganization: vi.fn(async () => undefined) };
      vi.mocked(getSessionAccessCacheDO).mockReturnValue(
        cache as unknown as ReturnType<typeof getSessionAccessCacheDO>
      );

      const res = await app.request(
        '/internal/session-access/invalidate',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Internal-Secret': secret,
          },
          body: JSON.stringify({
            kiloUserId: 'usr_removed',
            organizationId: '11111111-1111-4111-8111-111111111111',
          }),
        },
        defaultEnv
      );

      expect(res.status).toBe(401);
      expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
      expect(cache.invalidateOrganization).not.toHaveBeenCalled();
      expect(getUserConnectionDO).not.toHaveBeenCalled();
    }
  );

  it('invalidates cached access for the removed organization member', async () => {
    const cache = { invalidateOrganization: vi.fn(async () => undefined) };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      cache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );
    vi.mocked(getUserConnectionDO).mockReturnValue({
      closeViewerSockets: vi.fn(async () => 0),
    } as unknown as ReturnType<typeof getUserConnectionDO>);

    const res = await app.request(
      '/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Internal-Secret': 'internal-secret',
        },
        body: JSON.stringify({
          kiloUserId: 'usr_removed',
          organizationId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      defaultEnv
    );

    expect(res.status).toBe(204);
    expect(getSessionAccessCacheDO).toHaveBeenCalledWith(defaultEnv, {
      kiloUserId: 'usr_removed',
    });
    expect(cache.invalidateOrganization).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
  });

  it('closes the removed member viewer sockets', async () => {
    const cache = { invalidateOrganization: vi.fn(async () => undefined) };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      cache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );
    const closeViewerSockets = vi.fn(async () => 1);
    vi.mocked(getUserConnectionDO).mockReturnValue({
      closeViewerSockets,
    } as unknown as ReturnType<typeof getUserConnectionDO>);

    const res = await app.request(
      '/internal/session-access/invalidate',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Internal-Secret': 'internal-secret',
        },
        body: JSON.stringify({
          kiloUserId: 'usr_removed',
          organizationId: '11111111-1111-4111-8111-111111111111',
        }),
      },
      defaultEnv
    );

    expect(res.status).toBe(204);
    expect(getUserConnectionDO).toHaveBeenCalledWith(defaultEnv, {
      kiloUserId: 'usr_removed',
    });
    expect(closeViewerSockets).toHaveBeenCalled();
    expect(cache.invalidateOrganization).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
  });
});

describe('internal-secret middleware', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('protects the session export route with the shared internal-secret middleware', async () => {
    const res = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      { method: 'GET' },
      defaultEnv
    );

    expect(res.status).toBe(401);
  });

  it('returns 503 when the Secrets Store cannot resolve the internal secret', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const suppliedSecret = 'caller-supplied-secret';

    const res = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      {
        method: 'GET',
        headers: {
          'X-Internal-Secret': suppliedSecret,
        },
      },
      {
        ...defaultEnv,
        INTERNAL_API_SECRET_PROD: {
          get: async () => {
            throw new Error('secret store unavailable');
          },
        },
      }
    );

    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toEqual({ success: false, error: 'Service temporarily unavailable' });
    expect(JSON.stringify(body)).not.toContain('secret store unavailable');
    expect(JSON.stringify(body)).not.toContain(suppliedSecret);
    expect(error).toHaveBeenCalledWith(
      'Auth infrastructure failure',
      expect.objectContaining({
        operation: 'internal-api-secret-get',
        errorClass: 'Error',
      })
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(suppliedSecret);
    error.mockRestore();
  });
});

describe('public session route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 404 for malformed share tokens', async () => {
    const content = await app.request('/session/not-a-jwt', {}, defaultEnv);
    const metadata = await app.request('/session/not-a-jwt/metadata', {}, defaultEnv);
    expect(content.status).toBe(404);
    expect(metadata.status).toBe(404);
  });

  it('returns 404 when the token generation is not found', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([]);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });

    const res = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);

    expect(res.status).toBe(404);
  });

  it('returns a matching shared snapshot at the token boundary with no-store caching', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const now = new Date('2026-08-19T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const token = await signSessionShareToken(
        defaultEnv,
        {
          sessionId: 'ses_12345678901234567890123456',
          publicId: '11111111-1111-4111-8111-111111111111',
        },
        { now: () => now }
      );
      selectResult.mockResolvedValueOnce([
        {
          sessionId: 'ses_12345678901234567890123456',
          kiloUserId: 'usr_123',
          title: 'Shared title',
          ownerName: 'Shared owner',
        },
      ]);

      const stub = {
        getSharedSessionStream: vi.fn(async () => new Response('{"ok":true}').body!),
      };
      vi.mocked(getSessionIngestDO).mockReturnValue(
        stub as unknown as ReturnType<typeof getSessionIngestDO>
      );

      const res = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('{"ok":true}');
      expect(stub.getSharedSessionStream).toHaveBeenCalledWith({
        publicId: '11111111-1111-4111-8111-111111111111',
        ingestedBeforeMs: now.getTime(),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 404 for a superseded capability and serves the current generation', async () => {
    const { db, selectResult, selectCondition } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const now = new Date('2026-08-19T10:00:00.000Z');
    const sessionId = 'ses_12345678901234567890123456';
    const previousPublicId = '11111111-1111-4111-8111-111111111111';
    const currentPublicId = '22222222-2222-4222-8222-222222222222';
    const currentRow = {
      sessionId,
      kiloUserId: 'usr_123',
      title: 'Shared title',
      ownerName: 'Shared owner',
      gitUrl: null,
      gitBranch: null,
      createdAt: '2026-08-19T10:00:00.000Z',
    };

    selectResult.mockImplementation(async () => {
      const condition = selectCondition();
      if (!(condition instanceof SQL)) throw new Error('Expected a resolution predicate');
      const params = new PgDialect().sqlToQuery(condition).params;
      return params[1] === currentPublicId ? [currentRow] : [];
    });

    const stub = {
      getSharedSessionStream: vi.fn(async () => new Response('{"ok":true}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const previousToken = await signSessionShareToken(
      defaultEnv,
      { sessionId, publicId: previousPublicId },
      { now: () => now }
    );
    const currentToken = await signSessionShareToken(
      defaultEnv,
      { sessionId, publicId: currentPublicId },
      { now: () => new Date(now.getTime() + 1000) }
    );

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const previous = await app.request(
        `/session/${encodeURIComponent(previousToken)}`,
        {},
        defaultEnv
      );
      const current = await app.request(
        `/session/${encodeURIComponent(currentToken)}`,
        {},
        defaultEnv
      );
      const previousMetadata = await app.request(
        `/session/${encodeURIComponent(previousToken)}/metadata`,
        {},
        defaultEnv
      );
      const currentMetadata = await app.request(
        `/session/${encodeURIComponent(currentToken)}/metadata`,
        {},
        defaultEnv
      );

      expect(previous.status).toBe(404);
      expect(current.status).toBe(200);
      expect(await current.text()).toBe('{"ok":true}');
      expect(previousMetadata.status).toBe(404);
      expect(currentMetadata.status).toBe(200);
      expect(stub.getSharedSessionStream).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 404 for an expired capability on both content and metadata endpoints', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const now = new Date('2026-08-19T10:00:00.000Z');
    const token = await signSessionShareToken(
      defaultEnv,
      {
        sessionId: 'ses_12345678901234567890123456',
        publicId: '11111111-1111-4111-8111-111111111111',
      },
      { now: () => now }
    );
    const afterExpiry = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    selectResult.mockResolvedValue([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        createdAt: '2026-08-19T10:00:00.000Z',
      },
    ]);
    const stub = {
      getSharedSessionStream: vi.fn(),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    vi.useFakeTimers();
    vi.setSystemTime(afterExpiry);
    try {
      const content = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);
      const metadata = await app.request(
        `/session/${encodeURIComponent(token)}/metadata`,
        {},
        defaultEnv
      );

      expect(content.status).toBe(404);
      expect(metadata.status).toBe(404);
      expect(stub.getSharedSessionStream).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves original links as permanent live shares until revoked or replaced', async () => {
    const { db, selectResult, selectCondition } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValue([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        createdAt: '2026-08-19T10:00:00.000Z',
      },
    ]);
    const stub = {
      getAllStream: vi.fn(async () => new Response('{"messages":["later message"]}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(stub as never);
    const legacyToken = await new SignJWT({
      version: 1,
      sub: 'ses_12345678901234567890123456',
      jti: '11111111-1111-4111-8111-111111111111',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('kilo-session-ingest')
      .setAudience('kilo-session-share')
      .setIssuedAt(1)
      .sign(new TextEncoder().encode('session-share-secret-for-tests-32-bytes'));
    const path = `/session/${encodeURIComponent(legacyToken)}`;
    const content = await app.request(path, {}, defaultEnv);
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({ messages: ['later message'] });
    expect((await app.request(`${path}/metadata`, {}, defaultEnv)).status).toBe(200);
    const condition = selectCondition();
    if (!(condition instanceof SQL)) throw new Error('Expected generation condition');
    expect(new PgDialect().sqlToQuery(condition).params).toContain(
      '11111111-1111-4111-8111-111111111111'
    );
    selectResult.mockResolvedValue([]);
    expect((await app.request(path, {}, defaultEnv)).status).toBe(404);
    expect((await app.request(`${path}/metadata`, {}, defaultEnv)).status).toBe(404);
    expect(stub.getAllStream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'serves a new permanent link with include_new_messages=%s',
    async include_new_messages => {
      const { db, selectResult } = makeDbFakes();
      vi.mocked(getWorkerDb).mockReturnValue(db as never);
      selectResult.mockResolvedValue([
        {
          sessionId: 'ses_12345678901234567890123456',
          kiloUserId: 'usr_123',
        },
      ]);
      const stub = {
        getAllStream: vi.fn(async () => new Response('{"mode":"live"}').body!),
        getSharedSessionStream: vi.fn(async () => new Response('{"mode":"snapshot"}').body!),
      };
      vi.mocked(getSessionIngestDO).mockReturnValue(stub as never);
      const sharedAt = new Date('2020-01-01T00:00:00.000Z');
      const token = await signSessionShareToken(
        defaultEnv,
        {
          sessionId: 'ses_12345678901234567890123456',
          publicId: '11111111-1111-4111-8111-111111111111',
          duration: 'forever',
          include_new_messages,
        },
        { now: () => sharedAt }
      );
      const response = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mode: include_new_messages ? 'live' : 'snapshot' });
      if (include_new_messages) {
        expect(stub.getSharedSessionStream).not.toHaveBeenCalled();
      } else {
        expect(stub.getAllStream).not.toHaveBeenCalled();
        expect(stub.getSharedSessionStream).toHaveBeenCalledWith({
          publicId: '11111111-1111-4111-8111-111111111111',
          ingestedBeforeMs: sharedAt.getTime(),
        });
      }
    }
  );

  it('returns 404 for a revoked capability on both content and metadata endpoints', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValue([]);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    const stub = {
      getSharedSessionStream: vi.fn(),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const content = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);
    const metadata = await app.request(
      `/session/${encodeURIComponent(token)}/metadata`,
      {},
      defaultEnv
    );

    expect(content.status).toBe(404);
    expect(metadata.status).toBe(404);
    expect(stub.getSharedSessionStream).not.toHaveBeenCalled();
  });

  it('serializes created_at as UTC ISO at the HTTP boundary', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    selectResult.mockResolvedValueOnce([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        gitUrl: 'https://github.com/owner/repo',
        gitBranch: 'main',
        createdAt: '2026-08-19 19:28:42.33099+00',
      },
    ]);

    const res = await app.request(`/session/${encodeURIComponent(token)}/metadata`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      title: 'Shared title',
      owner_name: 'Shared owner',
      git_url: 'https://github.com/owner/repo',
      git_branch: 'main',
      created_at: '2026-08-19T19:28:42.330Z',
    });
  });

  it('returns shared metadata with no-store caching', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const token = await signSessionShareToken(defaultEnv, {
      sessionId: 'ses_12345678901234567890123456',
      publicId: '11111111-1111-4111-8111-111111111111',
    });
    selectResult.mockResolvedValueOnce([
      {
        sessionId: 'ses_12345678901234567890123456',
        kiloUserId: 'usr_123',
        title: 'Shared title',
        ownerName: 'Shared owner',
        gitUrl: 'https://github.com/owner/repo',
        gitBranch: 'main',
        createdAt: '2026-08-19T10:00:00.000Z',
      },
    ]);

    const res = await app.request(`/session/${encodeURIComponent(token)}/metadata`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      success: true,
      title: 'Shared title',
      owner_name: 'Shared owner',
      git_url: 'https://github.com/owner/repo',
      git_branch: 'main',
      created_at: '2026-08-19T10:00:00.000Z',
    });
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });
});
