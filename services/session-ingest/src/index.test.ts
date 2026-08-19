import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  const select = {
    from: vi.fn(() => select),
    leftJoin: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  const db = {
    select: vi.fn(() => select),
  };

  return { db, selectResult };
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
    const res = await app.request('/session/not-a-jwt', {}, defaultEnv);
    expect(res.status).toBe(404);
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

  it('returns a matching DO snapshot with no-store caching', async () => {
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
      },
    ]);

    const stub = {
      getAllStream: vi.fn(async () => new Response('{"ok":true}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const res = await app.request(`/session/${encodeURIComponent(token)}`, {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"ok":true}');
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
