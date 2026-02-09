import { Hono } from 'hono';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { api } from './api';
import type { HyperdriveBinding } from '../db/kysely';

vi.mock('../db/kysely', () => ({
  getDb: vi.fn(),
}));

vi.mock('../dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('../dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));

import { getDb } from '../db/kysely';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';

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
  type Db = ReturnType<typeof getDb>;

  const dbRef: Record<string, unknown> = {};

  const insertExecute = vi.fn<() => Promise<unknown>>(async () => undefined);
  const insert = {
    values: vi.fn(() => insert),
    onConflict: vi.fn(() => insert),
    execute: insertExecute,
  };

  const selectExecuteTakeFirst = vi.fn<() => Promise<unknown>>(async () => undefined);
  const selectExecute = vi.fn<() => Promise<unknown>>(async () => []);
  const select = {
    select: vi.fn(() => select),
    where: vi.fn(() => select),
    innerJoin: vi.fn(() => select),
    orderBy: vi.fn(() => select),
    unionAll: vi.fn(() => select),
    executeTakeFirst: selectExecuteTakeFirst,
    execute: selectExecute,
  };

  const updateExecute = vi.fn<() => Promise<unknown>>(async () => undefined);
  const updateSet = vi.fn(() => update);
  const updateWhere = vi.fn(() => update);
  const update = {
    set: updateSet,
    where: updateWhere,
    execute: updateExecute,
    executeTakeFirst: updateExecute,
  };

  const deleteExecute = vi.fn<() => Promise<unknown>>(async () => undefined);
  const del = {
    where: vi.fn(() => del),
    execute: deleteExecute,
  };

  const executeQuery = vi.fn(async () => ({ rows: [] as Array<{ session_id: string }> }));

  const transaction = vi.fn(() => ({
    execute: vi.fn(async (fn: (trx: unknown) => Promise<unknown>) => fn(dbRef as unknown)),
  }));

  const insertInto = vi.fn(() => insert);
  const selectFrom = vi.fn(() => select);
  const updateTable = vi.fn(() => update);
  const deleteFrom = vi.fn(() => del);

  const db = {
    insertInto,
    selectFrom,
    updateTable,
    deleteFrom,
    executeQuery,
    transaction,
    withRecursive: vi.fn(() => dbRef),
    // Kysely's sql``.compile(db) expects this shape.
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({ sql: '', parameters: [] }),
    }),
  } as unknown as Db;

  Object.assign(dbRef, db);

  return {
    db,
    fns: {
      insertInto,
      selectFrom,
      updateTable,
      updateSet,
      updateWhere,
      deleteFrom,
      insertExecute,
      selectExecuteTakeFirst,
      selectExecute,
      updateExecute,
      deleteExecute,
      executeQuery,
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
    vi.mocked(getDb).mockReturnValue(db);

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
    const { insertInto } = fns;
    vi.mocked(getDb).mockReturnValue(db);

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
    expect(insertInto).toHaveBeenCalledWith('cli_sessions_v2');
    expect(sessionCache.add).toHaveBeenCalledWith('ses_12345678901234567890123456');

    const json = await res.json();
    expect(json).toEqual({
      id: 'ses_12345678901234567890123456',
      ingestPath: '/api/session/ses_12345678901234567890123456/ingest',
    });
  });

  it('POST /session/:sessionId/ingest uses cache hit and updates title when changed', async () => {
    const { db, fns } = makeDbFakes();
    const { selectExecuteTakeFirst, updateTable } = fns;
    vi.mocked(getDb).mockReturnValue(db);

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
    expect(selectExecuteTakeFirst).not.toHaveBeenCalled();
    expect(ingestStub.ingest).toHaveBeenCalled();
    expect(updateTable).toHaveBeenCalledWith('cli_sessions_v2');
  });

  it('POST /session/:sessionId/ingest updates platform and orgId when changed', async () => {
    const { db, fns } = makeDbFakes();
    const { updateSet } = fns;
    vi.mocked(getDb).mockReturnValue(db);

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
    expect(updateSet).toHaveBeenCalledWith({ created_on_platform: 'github' });
    expect(updateSet).toHaveBeenCalledWith({
      organization_id: '00000000-0000-0000-0000-000000000000',
    });
  });

  it('POST /session/:sessionId/ingest updates parent_session_id when changed', async () => {
    const { db, fns } = makeDbFakes();
    const { selectExecuteTakeFirst, updateSet } = fns;
    vi.mocked(getDb).mockReturnValue(db);

    // New parent existence check.
    selectExecuteTakeFirst.mockResolvedValueOnce({ session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' });

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
    expect(selectExecuteTakeFirst).toHaveBeenCalled();
    expect(ingestStub.ingest).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({ parent_session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' });
  });

  it('POST /session/:sessionId/ingest returns 400 when parent_session_id is self', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getDb).mockReturnValue(db);

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
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);

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

    // Parent existence check fails.
    selectExecuteTakeFirst.mockResolvedValueOnce(undefined);

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
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce(undefined);

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
    expect(selectExecuteTakeFirst).toHaveBeenCalled();
  });

  it('GET /session/:sessionId/export returns 400 for invalid sessionId', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getDb).mockReturnValue(db);

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
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce(undefined);

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
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce({ session_id: 'ses_12345678901234567890123456' });

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
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce({ session_id: 'ses_12345678901234567890123456' });

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
    expect(selectExecuteTakeFirst).toHaveBeenCalled();
    expect(sessionCache.add).toHaveBeenCalledWith('ses_12345678901234567890123456');
  });

  it('DELETE /session/:sessionId revokes cache, clears DO, and deletes row', async () => {
    const { db, fns } = makeDbFakes();
    const { selectExecuteTakeFirst, selectExecute, deleteExecute } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce({ session_id: 'ses_12345678901234567890123456' });
    selectExecute.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

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
    expect(deleteExecute).toHaveBeenCalled();
  });

  it('POST /session/:sessionId/share returns existing public_id when already shared', async () => {
    const { db, fns } = makeDbFakes();
    const { selectExecuteTakeFirst } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce({
      session_id: 'ses_12345678901234567890123456',
      public_id: '11111111-1111-1111-1111-111111111111',
    });

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
    const { selectExecuteTakeFirst, updateExecute } = fns;
    vi.mocked(getDb).mockReturnValue(db);

    // First select: not shared yet
    selectExecuteTakeFirst.mockResolvedValueOnce({
      session_id: 'ses_12345678901234567890123456',
      public_id: null,
    });
    // Update succeeds and reports one updated row
    updateExecute.mockResolvedValueOnce({ numUpdatedRows: 1n } as unknown as never);

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
    const { selectExecuteTakeFirst, updateExecute } = fns;
    vi.mocked(getDb).mockReturnValue(db);

    // First select: not shared yet
    selectExecuteTakeFirst.mockResolvedValueOnce({
      session_id: 'ses_12345678901234567890123456',
      public_id: null,
    });
    // Update reports 0 updated rows, so code re-selects
    updateExecute.mockResolvedValueOnce({ numUpdatedRows: 0n } as unknown as never);
    // Second select: now has a public_id
    selectExecuteTakeFirst.mockResolvedValueOnce({
      public_id: '22222222-2222-2222-2222-222222222222',
    });

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
    const { selectExecuteTakeFirst, updateExecute } = fns;
    vi.mocked(getDb).mockReturnValue(db);
    selectExecuteTakeFirst.mockResolvedValueOnce({ session_id: 'ses_12345678901234567890123456' });

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/unshare', {
        method: 'POST',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(200);
    expect(updateExecute).toHaveBeenCalled();
  });
});
