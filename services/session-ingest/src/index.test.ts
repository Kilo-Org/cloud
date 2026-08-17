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

import { app } from './index';
import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';

type TestBindings = {
  HYPERDRIVE: { connectionString: string };
  SESSION_INGEST_DO: unknown;
  SESSION_ACCESS_CACHE_DO: unknown;
  NEXTAUTH_SECRET: unknown;
  NEXTAUTH_SECRET_RAW?: string;
  INTERNAL_API_SECRET_PROD: { get(): Promise<string> };
};

function makeDbFakes() {
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
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
    }
  );

  it('invalidates cached access for the removed organization member', async () => {
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
});

describe('public session route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 for invalid uuid', async () => {
    const res = await app.request('/session/not-a-uuid', {}, defaultEnv);
    expect(res.status).toBe(400);
  });

  it('returns 404 when public_id not found', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([]);

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(404);
  });

  it('returns DO snapshot json with content-type', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        kilo_user_id: 'usr_123',
      },
    ]);

    const stub = {
      getAllStream: vi.fn(async () => new Response('{"ok":true}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('{"ok":true}');
  });
});
