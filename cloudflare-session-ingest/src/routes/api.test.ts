import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { api } from './api';

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('../dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('../dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';

type HyperdriveBinding = { connectionString: string };

type TestBindings = {
  HYPERDRIVE: HyperdriveBinding;
};

function makeApiApp() {
  const app = new Hono<{ Bindings: TestBindings; Variables: { user_id: string } }>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/', api);
  return app;
}

function makeDbFakes() {
  type Db = ReturnType<typeof getWorkerDb>;

  const dbRef: Record<string, unknown> = {};

  // Drizzle insert chain: db.insert(table).values({}).onConflictDoNothing()/onConflictDoUpdate()
  const insert = {
    values: vi.fn(() => insert),
    onConflictDoNothing: vi.fn(() => insert),
    onConflictDoUpdate: vi.fn(() => insert),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(undefined)),
  };

  // Drizzle select chain: db.select({}).from(table).where().limit()
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  // Drizzle update chain: db.update(table).set({}).where().returning()
  const updateResult = vi.fn<() => Promise<unknown>>(async () => undefined);
  const updateSet = vi.fn(() => update);
  const updateWhere = vi.fn(() => update);
  const updateReturning = vi.fn(() => update);
  const update = {
    set: updateSet,
    where: updateWhere,
    returning: updateReturning,
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(updateResult())),
  };

  // Drizzle delete chain: db.delete(table).where()
  const deleteResult = vi.fn<() => Promise<unknown>>(async () => undefined);
  const del = {
    where: vi.fn(() => del),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(deleteResult())),
  };

  // db.execute(sql`...`) for raw SQL (recursive CTE)
  const executeResult = vi.fn(async () => ({ rows: [] as Array<{ session_id: string }> }));

  // db.transaction(async (tx) => { ... })
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbRef as unknown));

  const insertFn = vi.fn(() => insert);
  const selectFn = vi.fn(() => select);
  const updateFn = vi.fn(() => update);
  const deleteFn = vi.fn(() => del);

  const db = {
    insert: insertFn,
    select: selectFn,
    update: updateFn,
    delete: deleteFn,
    execute: executeResult,
    transaction,
  } as unknown as Db;

  Object.assign(dbRef, db);

  return {
    db,
    fns: {
      insert: insertFn,
      select: selectFn,
      update: updateFn,
      updateSet,
      updateWhere,
      updateReturning,
      delete: deleteFn,
      selectResult,
      updateResult,
      deleteResult,
      executeResult,
      transaction,
    },
  };
}

describe('api routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 for invalid sessionId on ingest/delete/share/unshare', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [],
      })),
      clear: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const env: TestBindings = { HYPERDRIVE: { connectionString: 'postgres://test' } };

    const invalid = 'not-a-session';
    const ingestRes = await app.fetch(
      new Request(`http://local/session/${invalid}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }),
      env
    );
    expect(ingestRes.status).toBe(400);

    const deleteRes = await app.fetch(
      new Request(`http://local/session/${invalid}`, {
        method: 'DELETE',
      }),
      env
    );
    expect(deleteRes.status).toBe(400);

    const shareRes = await app.fetch(
      new Request(`http://local/session/${invalid}/share`, {
        method: 'POST',
      }),
      env
    );
    expect(shareRes.status).toBe(400);

    const unshareRes = await app.fetch(
      new Request(`http://local/session/${invalid}/unshare`, {
        method: 'POST',
      }),
      env
    );
    expect(unshareRes.status).toBe(400);
  });

  it('POST /session persists placeholder and warms cache', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      add: vi.fn(async () => undefined),
      has: vi.fn(async () => true),
      remove: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_12345678901234567890123456' }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(fns.insert).toHaveBeenCalled();
    expect(sessionCache.add).toHaveBeenCalledWith('ses_12345678901234567890123456');

    const json = await res.json();
    expect(json).toEqual({
      id: 'ses_12345678901234567890123456',
      ingestPath: '/api/session/ses_12345678901234567890123456/ingest',
    });
  });

  it('POST /session/:sessionId/ingest uses cache hit and updates title when changed', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [{ name: 'title', value: 'Hello' }],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{ type: 'session', data: { title: 'Hello' } }],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(sessionCache.has).toHaveBeenCalledWith('ses_12345678901234567890123456');
    expect(fns.selectResult).not.toHaveBeenCalled();
    expect(ingestStub.ingest).toHaveBeenCalled();
    expect(fns.update).toHaveBeenCalled();
  });

  it('POST /session/:sessionId/ingest updates platform and orgId when changed', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [
          { name: 'platform', value: 'github' },
          { name: 'orgId', value: '00000000-0000-0000-0000-000000000000' },
        ],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              type: 'kilo_meta',
              data: { platform: 'github', orgId: '00000000-0000-0000-0000-000000000000' },
            },
          ],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    // In Drizzle, all fields are set in a single .set() call
    expect(fns.updateSet).toHaveBeenCalledWith({
      created_on_platform: 'github',
      organization_id: '00000000-0000-0000-0000-000000000000',
    });
  });

  it('POST /session/:sessionId/ingest updates git_url and git_branch when changed', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [
          { name: 'gitUrl', value: 'https://github.com/user/repo' },
          { name: 'gitBranch', value: 'main' },
        ],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [
            {
              type: 'kilo_meta',
              data: {
                platform: 'cli',
                gitUrl: 'https://github.com/user/repo',
                gitBranch: 'main',
              },
            },
          ],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    // In Drizzle, all changed fields are set in a single .set() call.
    // The mock only returns gitUrl and gitBranch changes (not platform).
    expect(fns.updateSet).toHaveBeenCalledWith({
      git_url: 'https://github.com/user/repo',
      git_branch: 'main',
    });
  });

  it('POST /session/:sessionId/ingest updates parent_session_id when changed', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    // Parent existence check: select returns a match.
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' }]);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [{ name: 'parentId', value: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{ type: 'session', data: { parentID: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' } }],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(sessionCache.has).toHaveBeenCalledWith('ses_12345678901234567890123456');
    expect(fns.selectResult).toHaveBeenCalled();
    expect(ingestStub.ingest).toHaveBeenCalled();
    expect(fns.updateSet).toHaveBeenCalledWith({
      parent_session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('POST /session/:sessionId/ingest returns 400 when parent_session_id is self', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [{ name: 'parentId', value: 'ses_12345678901234567890123456' }],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{ type: 'session', data: { parentID: 'ses_12345678901234567890123456' } }],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'parent_session_id_cannot_be_self',
    });
  });

  it('POST /session/:sessionId/ingest returns 404 when parent_session_id is missing', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      has: vi.fn(async () => true),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [{ name: 'parentId', value: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' }],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    // Parent existence check fails — returns empty array.
    fns.selectResult.mockResolvedValueOnce([]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{ type: 'session', data: { parentID: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' } }],
        }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'parent_session_not_found',
    });
  });

  it('POST /session/:sessionId/ingest returns 404 on cache miss + missing session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    // Session existence check fails — returns empty array.
    fns.selectResult.mockResolvedValueOnce([]);

    const sessionCache = {
      has: vi.fn(async () => false),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(404);
    expect(fns.selectResult).toHaveBeenCalled();
  });

  it('GET /session/:sessionId/export returns 400 for invalid sessionId', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const app = makeApiApp();
    const invalid = 'not-a-session';
    const res = await app.fetch(
      new Request(`http://local/session/${invalid}/export`, {
        method: 'GET',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid sessionId' });
  });

  it('GET /session/:sessionId/export returns 404 when session missing', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    // Session existence check returns empty.
    fns.selectResult.mockResolvedValueOnce([]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/export', {
        method: 'GET',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: 'session_not_found' });
  });

  it('GET /session/:sessionId/export returns DO payload for valid session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const payload = JSON.stringify({ success: true, events: [] });
    const ingestStub = {
      getAll: vi.fn(async () => payload),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/export', {
        method: 'GET',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe(payload);
    expect(ingestStub.getAll).toHaveBeenCalled();
  });

  it('POST /session/:sessionId/ingest backfills cache on cache miss + existing session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const sessionCache = {
      has: vi.fn(async () => false),
      add: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      ingest: vi.fn(async () => ({
        changes: [],
      })),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(fns.selectResult).toHaveBeenCalled();
    expect(sessionCache.add).toHaveBeenCalledWith('ses_12345678901234567890123456');
  });

  it('DELETE /session/:sessionId revokes cache, clears DO, and deletes row', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    // Ownership check
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);
    // Recursive CTE
    fns.executeResult.mockResolvedValueOnce({
      rows: [{ session_id: 'ses_12345678901234567890123456' }],
    });

    const sessionCache = {
      remove: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const ingestStub = {
      clear: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456', {
        method: 'DELETE',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(sessionCache.remove).toHaveBeenCalledWith('ses_12345678901234567890123456');
    expect(ingestStub.clear).toHaveBeenCalled();
    expect(fns.deleteResult).toHaveBeenCalled();
  });

  it('POST /session/:sessionId/share returns existing public_id when already shared', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        public_id: '11111111-1111-1111-1111-111111111111',
      },
    ]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      public_id: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('POST /session/:sessionId/share sets public_id when missing', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    // First select: not shared yet
    fns.selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        public_id: null,
      },
    ]);
    // Update returning succeeds with one row
    fns.updateResult.mockResolvedValueOnce([{ public_id: 'some-uuid' }]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toMatchObject({ success: true });
    const publicId = (json as { public_id?: unknown }).public_id;
    expect(typeof publicId).toBe('string');
    expect((publicId as string).length).toBeGreaterThan(0);
  });

  it('POST /session/:sessionId/share returns existing public_id when update is raced', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    // First select: not shared yet
    fns.selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        public_id: null,
      },
    ]);
    // Update returning returns empty (raced)
    fns.updateResult.mockResolvedValueOnce([]);
    // Second select: now has a public_id
    fns.selectResult.mockResolvedValueOnce([
      {
        public_id: '22222222-2222-2222-2222-222222222222',
      },
    ]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      public_id: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('POST /session/:sessionId/unshare clears public_id when session exists', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/unshare', {
        method: 'POST',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(fns.updateSet).toHaveBeenCalled();
  });
});
