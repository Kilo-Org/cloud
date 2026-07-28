import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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

vi.mock('../dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

vi.mock('../ingest/metadata', () => ({
  applyMetadataChanges: vi.fn(async () => undefined),
}));

vi.mock('../services/session-access', () => ({
  resolveAccessibleKiloSession: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from '../dos/SessionIngestDO';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { getUserConnectionDO } from '../dos/UserConnectionDO';
import { applyMetadataChanges } from '../ingest/metadata';
import { notifyUserSessionEvent } from '../session-events';
import { resolveAccessibleKiloSession } from '../services/session-access';
import type * as SessionEvents from '../session-events';

vi.mock('../session-events', async importOriginal => {
  const actual = await importOriginal<typeof SessionEvents>();
  return {
    ...actual,
    notifyUserSessionEvent: vi.fn(),
  };
});

type HyperdriveBinding = { connectionString: string };

type TestBindings = {
  HYPERDRIVE: HyperdriveBinding;
  SESSION_INGEST_R2: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  INGEST_QUEUE: { send: ReturnType<typeof vi.fn> };
  NOTIFICATIONS: {
    sendSessionReadyNotification: ReturnType<typeof vi.fn>;
    sendCloudAgentSessionNotification: ReturnType<typeof vi.fn>;
  };
  DIRECT_INGEST_PERCENT: string;
  DIRECT_INGEST_USER_IDS: string;
  DIRECT_INGEST_MAX_BYTES: string;
};

function makeTestEnv(overrides: Partial<TestBindings> = {}): TestBindings {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    SESSION_INGEST_R2: {
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    NOTIFICATIONS: {
      sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
      sendCloudAgentSessionNotification: vi.fn(async () => ({ dispatched: true })),
    },
    DIRECT_INGEST_PERCENT: '0',
    DIRECT_INGEST_USER_IDS: '',
    DIRECT_INGEST_MAX_BYTES: '4194304',
    ...overrides,
  };
}

function makeApiApp() {
  const app = new Hono<{ Bindings: TestBindings; Variables: { user_id: string } }>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/', api);
  return app;
}

function directIngestEnv(overrides: Partial<TestBindings> = {}) {
  return makeTestEnv({ DIRECT_INGEST_USER_IDS: 'usr_test', ...overrides });
}

function ingestRequest(body: string, contentLength = new TextEncoder().encode(body).byteLength) {
  return new Request('http://local/session/ses_12345678901234567890123456/ingest?v=1', {
    method: 'POST',
    headers: { 'content-length': String(contentLength) },
    body,
  });
}

function prepareIngestRoute(
  ingest: ReturnType<typeof vi.fn> = vi.fn(async () => ({ accepted: true, changes: [] }))
) {
  const { db } = makeDbFakes();
  vi.mocked(getWorkerDb).mockReturnValue(db);
  vi.mocked(getSessionAccessCacheDO).mockReturnValue({ has: vi.fn(async () => true) } as never);
  vi.mocked(getSessionIngestDO).mockReturnValue({ ingest } as never);
  vi.mocked(getUserConnectionDO).mockReturnValue({
    hasActiveCliSession: vi.fn(async () => true),
  } as never);
  vi.mocked(applyMetadataChanges).mockResolvedValue(undefined);
  return { app: makeApiApp(), ingest };
}

function makeDbFakes() {
  type Db = ReturnType<typeof getWorkerDb>;

  const dbRef: Record<string, unknown> = {};

  // Drizzle insert chain: db.insert(table).values({}).onConflictDoNothing()/onConflictDoUpdate()
  const insertResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const insert = {
    values: vi.fn(() => insert),
    onConflictDoNothing: vi.fn(() => insert),
    onConflictDoUpdate: vi.fn(() => insert),
    returning: vi.fn(() => insert),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(insertResult())),
  };

  // Drizzle select chain: db.select({}).from(table).where().limit()
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
    leftJoin: vi.fn(() => select),
    where: vi.fn((_condition: unknown) => select),
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
    where: vi.fn((_condition: unknown) => del),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(deleteResult())),
  };

  // db.execute(sql`...`) for raw SQL (recursive CTE)
  const executeResult = vi.fn(async (_query?: unknown) => ({
    rows: [] as Array<Record<string, unknown>>,
  }));

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
      insertResult,
      select: selectFn,
      selectWhere: select.where,
      update: updateFn,
      updateSet,
      updateWhere,
      updateReturning,
      delete: deleteFn,
      deleteWhere: del.where,
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
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });
  });

  it('returns 400 for invalid sessionId on ingest/delete/share/unshare', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const sessionCache = {
      getAccess: vi.fn(async () => null),
      putValidated: vi.fn(async () => undefined),
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
    const env = makeTestEnv();

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

  it('POST /session emits created only for newly inserted rows', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.insertResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        title: null,
        created_on_platform: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        parent_session_id: null,
        status: null,
        status_updated_at: null,
      },
    ]);

    const sessionCache = {
      getAccess: vi.fn(async () => null),
      putValidated: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const app = makeApiApp();
    const env = makeTestEnv();
    const res = await app.fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_12345678901234567890123456' }),
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(fns.select).not.toHaveBeenCalled();
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      expect.anything(),
      'usr_test',
      expect.objectContaining({ type: 'session.created' })
    );
    // The session-ready push fires from the queue consumer on first ingest
    // (where parentID is known), never at creation.
    expect(env.NOTIFICATIONS.sendSessionReadyNotification).not.toHaveBeenCalled();
  });

  it('POST /session does not emit created when row already exists', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.insertResult.mockResolvedValueOnce([]);

    const sessionCache = {
      getAccess: vi.fn(async () => null),
      putValidated: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    vi.mocked(getSessionAccessCacheDO).mockReturnValue(
      sessionCache as unknown as ReturnType<typeof getSessionAccessCacheDO>
    );

    const app = makeApiApp();
    const env = makeTestEnv();
    const res = await app.fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_12345678901234567890123456' }),
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(fns.select).not.toHaveBeenCalled();
    expect(notifyUserSessionEvent).not.toHaveBeenCalled();
    expect(env.NOTIFICATIONS.sendSessionReadyNotification).not.toHaveBeenCalled();
  });

  it('POST /session caches a newly created personal session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.insertResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        title: null,
        created_on_platform: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        parent_session_id: null,
        status: null,
        status_updated_at: null,
      },
    ]);

    const sessionCache = {
      putValidated: vi.fn(async () => undefined),
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
      makeTestEnv()
    );

    expect(res.status).toBe(200);
    expect(fns.insert).toHaveBeenCalled();
    expect(sessionCache.putValidated).toHaveBeenCalledWith({
      sessionId: 'ses_12345678901234567890123456',
      organizationId: null,
    });

    const json = await res.json();
    expect(json).toEqual({
      id: 'ses_12345678901234567890123456',
      ingestPath: '/api/session/ses_12345678901234567890123456/ingest',
    });
  });

  it('POST /session succeeds when cache warming is unavailable during rollout', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.insertResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        title: null,
        created_on_platform: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        parent_session_id: null,
        status: null,
        status_updated_at: null,
      },
    ]);
    const putValidated = vi.fn(async () => {
      throw new Error('The RPC receiver does not implement "putValidated".');
    });
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await makeApiApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'ses_12345678901234567890123456' }),
      }),
      makeTestEnv()
    );

    expect(res.status).toBe(200);
    expect(putValidated).toHaveBeenCalled();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it('POST /session/:sessionId/ingest streams to R2 after access is resolved', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const app = makeApiApp();
    const env = makeTestEnv();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{ type: 'session', data: { title: 'Hello' } }],
        }),
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(resolveAccessibleKiloSession).toHaveBeenCalledWith(env, {
      kiloUserId: 'usr_test',
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    expect(env.SESSION_INGEST_R2.put).toHaveBeenCalledTimes(1);
    expect(env.INGEST_QUEUE.send).toHaveBeenCalledTimes(1);

    // Verify queue message shape
    const queueMsg = env.INGEST_QUEUE.send.mock.calls[0][0] as Record<string, unknown>;
    expect(queueMsg).toMatchObject({
      kiloUserId: 'usr_test',
      sessionId: 'ses_12345678901234567890123456',
      ingestVersion: 0,
    });
    expect(queueMsg['r2Key']).toMatch(/^ingest\/usr_test\/ses_12345678901234567890123456\//);
    expect(typeof queueMsg['ingestedAt']).toBe('number');
  });

  it('timestamps a gate-miss legacy message after R2 staging', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ has: vi.fn(async () => true) } as never);

    const app = makeApiApp();
    const env = makeTestEnv();
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(123).mockReturnValueOnce(456);

    const response = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        body: JSON.stringify({ data: [] }),
      }),
      env
    );
    now.mockRestore();

    expect(response.status).toBe(200);
    expect(env.INGEST_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ ingestedAt: 456 })
    );
  });

  it('deletes the staged object when queue enqueue fails', async () => {
    const { db } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ has: vi.fn(async () => true) } as never);

    const app = makeApiApp();
    const env = makeTestEnv();
    env.INGEST_QUEUE.send.mockRejectedValueOnce(new Error('queue unavailable'));

    const response = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(response.status).toBe(500);
    const r2Key = env.SESSION_INGEST_R2.put.mock.calls[0][0];
    expect(env.SESSION_INGEST_R2.delete).toHaveBeenCalledWith(r2Key);
  });

  it.each([
    ['DELETE', '/session/ses_12345678901234567890123456'],
    ['POST', '/session/ses_12345678901234567890123456/unshare'],
  ])('%s %s denies a removed organization member before mutations', async (method, path) => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValue([
      {
        session_id: 'ses_12345678901234567890123456',
        public_id: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValueOnce(null);

    const res = await makeApiApp().fetch(
      new Request(`http://local${path}`, { method }),
      makeTestEnv()
    );

    expect(res.status).toBe(404);
    expect(fns.select).not.toHaveBeenCalled();
    expect(fns.executeResult).not.toHaveBeenCalled();
    expect(fns.update).not.toHaveBeenCalled();
    expect(fns.delete).not.toHaveBeenCalled();
  });

  it('POST /session/:sessionId/ingest denies a removed organization member before side effects', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValue([{ session_id: 'ses_12345678901234567890123456' }]);
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValueOnce(null);

    const app = makeApiApp();
    const env = makeTestEnv();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(res.status).toBe(404);
    expect(fns.select).not.toHaveBeenCalled();
    expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
    expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
  });

  describe('direct ingest', () => {
    it('persists an eligible payload with one DO RPC and no R2 or queue writes', async () => {
      const ingest = vi.fn(async () => ({
        accepted: true as const,
        changes: [{ name: 'title' as const, value: 'Direct' }],
      }));
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      const body = JSON.stringify({ data: [{ type: 'session', data: { title: 'Direct' } }] });
      const now = vi.spyOn(Date, 'now').mockReturnValue(1234);

      const response = await app.fetch(ingestRequest(body), env);
      now.mockRestore();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledWith(
        [{ type: 'session', data: { title: 'Direct' } }],
        'usr_test',
        'ses_12345678901234567890123456',
        1,
        1234
      );
      expect(applyMetadataChanges).toHaveBeenCalledTimes(1);
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
    });

    it('accepts the old DO response shape during gradual deployment', async () => {
      const ingest = vi.fn(async () => ({
        changes: [{ name: 'title' as const, value: 'Legacy DO' }],
      }));
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      const body = JSON.stringify({ data: [{ type: 'session', data: { title: 'Legacy DO' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(applyMetadataChanges).toHaveBeenCalledTimes(1);
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
    });

    it.skip('dispatches attention signals for an eligible direct ingest', async () => {
      const ingest = vi.fn(async () => ({
        accepted: true as const,
        changes: [],
        attentionSignals: [
          { signalId: 'msg_1', kind: 'completed' as const, messageExcerpt: 'All done' },
        ],
      }));
      const { app } = prepareIngestRoute(ingest);
      const { db, fns } = makeDbFakes();
      fns.selectResult.mockResolvedValueOnce([{ parentSessionId: null }]);
      vi.mocked(getWorkerDb).mockReturnValue(db);
      const env = directIngestEnv();
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(env.NOTIFICATIONS.sendCloudAgentSessionNotification).toHaveBeenCalledWith({
        userId: 'usr_test',
        cliSessionId: 'ses_12345678901234567890123456',
        executionId: 'remote:msg_1',
        status: 'completed',
        body: 'All done',
        suppressIfViewingSession: true,
      });
    });

    it.skip('keeps direct ingest successful when attention dispatch fails', async () => {
      const ingest = vi.fn(async () => ({
        accepted: true as const,
        changes: [],
        attentionSignals: [
          { signalId: 'msg_1', kind: 'completed' as const, messageExcerpt: 'All done' },
        ],
      }));
      const { app } = prepareIngestRoute(ingest);
      const { db, fns } = makeDbFakes();
      fns.selectResult.mockResolvedValueOnce([{ parentSessionId: null }]);
      vi.mocked(getWorkerDb).mockReturnValue(db);
      const env = directIngestEnv();
      env.NOTIFICATIONS.sendCloudAgentSessionNotification.mockRejectedValueOnce(
        new Error('notifications unavailable')
      );
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_attention_error' })
      );
      error.mockRestore();
    });

    it('completes a bodyless gate miss with an empty staged stream', async () => {
      const { app, ingest } = prepareIngestRoute();
      const env = makeTestEnv();
      const request = new Request(
        'http://local/session/ses_12345678901234567890123456/ingest?v=1',
        { method: 'POST' }
      );

      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      const stagedBody = env.SESSION_INGEST_R2.put.mock.calls[0][1] as ReadableStream<Uint8Array>;
      await expect(new Response(stagedBody).arrayBuffer()).resolves.toHaveProperty('byteLength', 0);
      expect(env.INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['invalid config', { DIRECT_INGEST_PERCENT: 'invalid' }, 'gate_config'],
      ['percent miss', { DIRECT_INGEST_USER_IDS: '' }, 'gate_percent'],
    ] as const)('uses the streaming legacy path for %s', async (_name, overrides, reason) => {
      const { app, ingest } = prepareIngestRoute();
      const env = makeTestEnv(overrides);
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).toHaveBeenCalledTimes(1);
      expect(env.INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_legacy', reason })
      );
      info.mockRestore();
      error.mockRestore();
    });

    it.each([
      ['missing', undefined, 'no_content_length'],
      ['negative', '-1', 'invalid_content_length'],
      ['fractional', '1.5', 'invalid_content_length'],
      ['non-numeric', 'abc', 'invalid_content_length'],
      ['zero', '0', 'empty_body'],
      ['over cap', '4194305', 'oversized_body'],
    ])('uses the legacy path for %s Content-Length', async (_name, contentLength, reason) => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const headers = contentLength === undefined ? undefined : { 'content-length': contentLength };
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const request = new Request(
        'http://local/session/ses_12345678901234567890123456/ingest?v=1',
        { method: 'POST', headers, body: '{}' }
      );

      const response = await app.fetch(request, env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_legacy', reason })
      );
      info.mockRestore();
    });

    it('keeps gate-miss staging failures out of the direct fallback denominator', async () => {
      const { app } = prepareIngestRoute();
      const env = makeTestEnv();
      env.SESSION_INGEST_R2.put.mockRejectedValueOnce(new Error('r2 failed'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest('{}'), env);

      expect(response.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'direct_ingest_legacy',
          reason: 'gate_percent',
          failureStage: 'staging_upload',
        })
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_fallback' })
      );
      warn.mockRestore();
    });

    it('returns 413 when actual bytes exceed the declaration', async () => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const body = JSON.stringify({ data: [] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(body, body.length - 1), env);

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ success: false, error: 'payload_too_large' });
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'direct_ingest_reject',
          reason: 'declared_bytes_exceeded',
        })
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_legacy' })
      );
      warn.mockRestore();
    });

    it('logs a terminal event when the selected request body stream fails', async () => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('body disconnected');
        },
      });
      const request = new Request(
        'http://local/session/ses_12345678901234567890123456/ingest?v=1',
        {
          method: 'POST',
          headers: { 'content-length': '10' },
          body,
          duplex: 'half',
        } as RequestInit
      );

      const response = await app.fetch(request, env);

      expect(response.status).toBe(500);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'direct_ingest_error',
          stage: 'body_read',
          error: 'body disconnected',
        })
      );
      warn.mockRestore();
      error.mockRestore();
    });

    it('accepts a body exactly at the configured cap', async () => {
      const { app, ingest } = prepareIngestRoute();
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_cap' } }] });
      const env = directIngestEnv({ DIRECT_INGEST_MAX_BYTES: String(body.length) });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
    });

    it.each([
      ['malformed JSON', '{"data":[', 400, 'malformed_json'],
      [
        'valid prefix with malformed tail',
        '{"data":[{"type":"message","data":{"id":"msg_1"}},broken',
        400,
        'malformed_json',
      ],
    ] as const)('rejects %s without persistence', async (_name, body, status, responseError) => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ success: false, error: responseError });
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it.each([
      ['empty', { data: [] }, 'empty_data'],
      ['missing', {}, 'missing_data'],
      ['wrong-shaped', { data: {} }, 'wrong_type_data'],
      ['all-invalid', { data: [{ type: 'message', data: {} }] }, 'no_valid_items'],
    ])('returns a no-op for %s data', async (_name, payload, reason) => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(JSON.stringify(payload)), env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_noop', reason, items: 0 })
      );
      expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'direct_ingest_ok' }));
      info.mockRestore();
      warn.mockRestore();
    });

    it('routes an item requiring R2 offload through the queue with exact bytes', async () => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv({ DIRECT_INGEST_MAX_BYTES: '3000000' });
      const body = JSON.stringify({
        data: [{ type: 'message', data: { id: 'msg_large', content: 'x'.repeat(2_100_000) } }],
      });
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).toHaveBeenCalledWith(
        expect.stringMatching(/\/ses_12345678901234567890123456\//),
        new TextEncoder().encode(body)
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_legacy', reason: 'oversized_item' })
      );
      info.mockRestore();
    });

    it('routes more than 128 valid items through the queue', async () => {
      const { app, ingest } = prepareIngestRoute();
      const env = directIngestEnv();
      const items = Array.from({ length: 129 }, (_, index) => ({
        type: 'message',
        data: { id: `msg_${index}` },
      }));
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await app.fetch(ingestRequest(JSON.stringify({ data: items })), env);

      expect(response.status).toBe(200);
      expect(ingest).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'direct_ingest_legacy',
          reason: 'multi_chunk',
          items: 129,
        })
      );
      info.mockRestore();
    });

    it('falls back with the original bytes and timestamp when the direct RPC fails', async () => {
      const retryableError = Object.assign(new Error('rpc failed'), { retryable: true });
      const ingest = vi.fn(async () => {
        throw retryableError;
      });
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const now = vi.spyOn(Date, 'now').mockReturnValue(4567);
      const requestId = vi
        .spyOn(crypto, 'randomUUID')
        .mockReturnValue('11111111-1111-4111-8111-111111111111');

      const response = await app.fetch(ingestRequest(body), env);
      now.mockRestore();
      requestId.mockRestore();

      expect(response.status).toBe(200);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(env.SESSION_INGEST_R2.put).toHaveBeenCalledWith(
        'ingest/usr_test/ses_12345678901234567890123456/11111111-1111-4111-8111-111111111111',
        new TextEncoder().encode(body)
      );
      expect(env.INGEST_QUEUE.send).toHaveBeenCalledWith(
        expect.objectContaining({ ingestedAt: 4567 })
      );
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_fallback', stage: 'do_rpc' })
      );
      warn.mockRestore();
    });

    it.each([
      ['staging upload', 'staging_upload'],
      ['queue send', 'queue_send'],
    ] as const)('logs the %s stage when durable fallback fails', async (failure, stage) => {
      const ingest = vi.fn(async () => {
        throw new Error('rpc failed');
      });
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      if (stage === 'staging_upload') {
        env.SESSION_INGEST_R2.put.mockRejectedValueOnce(new Error('r2 failed'));
      } else {
        env.INGEST_QUEUE.send.mockRejectedValueOnce(new Error('queue failed'));
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'direct_ingest_fallback',
          stage,
          directError: 'rpc failed',
        })
      );
      warn.mockRestore();
    });

    it('returns 404 for a tombstoned direct ingest without metadata or fallback', async () => {
      const ingest = vi.fn(
        async () => ({ accepted: false, reason: 'deleted', changes: [] }) as const
      );
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(404);
      expect(applyMetadataChanges).not.toHaveBeenCalled();
      expect(env.SESSION_INGEST_R2.put).not.toHaveBeenCalled();
      expect(env.INGEST_QUEUE.send).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_tombstone' })
      );
      info.mockRestore();
    });

    it('keeps direct success when synchronous metadata projection fails', async () => {
      const ingest = vi.fn(async () => ({
        accepted: true as const,
        changes: [{ name: 'title' as const, value: 'Direct' }],
      }));
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      vi.mocked(applyMetadataChanges).mockRejectedValueOnce(new Error('metadata failed'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const body = JSON.stringify({ data: [{ type: 'session', data: { title: 'Direct' } }] });

      const response = await app.fetch(ingestRequest(body), env);

      expect(response.status).toBe(200);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_metadata_error' })
      );
      error.mockRestore();
      info.mockRestore();
    });

    it('schedules caught metadata projection with ExecutionContext', async () => {
      const ingest = vi.fn(async () => ({
        accepted: true as const,
        changes: [{ name: 'title' as const, value: 'Direct' }],
      }));
      const { app } = prepareIngestRoute(ingest);
      const env = directIngestEnv();
      vi.mocked(applyMetadataChanges).mockRejectedValueOnce(new Error('metadata failed'));
      const waitUntil = vi.fn();
      const executionContext = {
        waitUntil,
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const body = JSON.stringify({ data: [{ type: 'session', data: { title: 'Direct' } }] });

      const response = await app.fetch(ingestRequest(body), env, executionContext);
      await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));

      expect(response.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'direct_ingest_metadata_error' })
      );
      error.mockRestore();
      info.mockRestore();
    });
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
      makeTestEnv()
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid sessionId' });
  });

  it('GET /session/:sessionId/export returns 404 when access is denied', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValue([{ session_id: 'ses_12345678901234567890123456' }]);
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValueOnce(null);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/export', {
        method: 'GET',
      }),
      makeTestEnv()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: 'session_not_found' });
    expect(fns.select).not.toHaveBeenCalled();
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('GET /session/:sessionId/export returns DO payload for valid session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const payload = JSON.stringify({ success: true, events: [] });
    const ingestStub = {
      getAllStream: vi.fn(async () => new Response(payload).body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      ingestStub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/export', {
        method: 'GET',
      }),
      makeTestEnv()
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe(payload);
    expect(ingestStub.getAllStream).toHaveBeenCalled();
  });

  it('GET /session/:sessionId/messages returns 400 for invalid sessionId', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/not-a-session/messages', { method: 'GET' }),
      makeTestEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid sessionId' });
  });

  it('GET /session/:sessionId/messages returns 400 for an invalid limit', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages?limit=999', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid limit' });
  });

  it('GET /session/:sessionId/messages returns 400 for limit=0 (the generic endpoint is always bounded)', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages?limit=0', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid limit' });
  });

  it('GET /session/:sessionId/messages returns 400 for limit=0 even when a cursor is supplied', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request(
        'http://local/session/ses_12345678901234567890123456/messages?limit=0&before=eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0',
        { method: 'GET' }
      ),
      makeTestEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid limit' });
  });

  it('GET /session/:sessionId/messages returns 400 when before is supplied without a positive limit', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages?before=not-valid', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'Invalid paging input' });
  });

  it('GET /session/:sessionId/messages returns 404 when the user does not own the session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([]);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages?limit=50', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, error: 'session_not_found' });
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('GET /session/:sessionId/messages returns the bounded page for an owned session', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const sdkStoredMessage = {
      info: {
        id: 'msg_user_01',
        sessionID: 'ses_12345678901234567890123456',
        role: 'user',
        time: { created: 1761000000100 },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      },
      parts: [
        {
          id: 'prt_user_01',
          sessionID: 'ses_12345678901234567890123456',
          messageID: 'msg_user_01',
          type: 'text',
          text: 'hello',
        },
      ],
    };
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessage],
      nextCursor: 'opaque-cursor',
      omittedItemCount: 0,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages?limit=50', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      kiloSessionId: 'ses_12345678901234567890123456',
      history: {
        messages: [sdkStoredMessage],
        nextCursor: 'opaque-cursor',
        omittedItemCount: 0,
      },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({ limit: 50, before: undefined });
  });

  it('GET /session/:sessionId/messages defaults an omitted limit to the shared page size', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValueOnce([{ session_id: 'ses_12345678901234567890123456' }]);

    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/messages', {
        method: 'GET',
      }),
      makeTestEnv()
    );
    expect(res.status).toBe(200);
    expect(readKiloSdkMessages).toHaveBeenCalledWith({
      limit: 50,
      before: undefined,
    });
  });

  it('GET /session/:sessionId/messages preserves durable retryable / too_large / invalid_data outcomes', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.selectResult.mockResolvedValue([{ session_id: 'ses_12345678901234567890123456' }]);

    const app = makeApiApp();

    for (const history of [
      { kind: 'retryable_failure', phase: 'page_parts' },
      { kind: 'too_large', maximumBytes: 8 * 1024 * 1024, phase: 'message_scan' },
      { kind: 'invalid_data' },
    ]) {
      vi.mocked(getSessionIngestDO).mockReturnValue({
        readKiloSdkMessages: vi.fn(async () => history),
      } as never);
      const res = await app.fetch(
        new Request('http://local/session/ses_12345678901234567890123456/messages?limit=10', {
          method: 'GET',
        }),
        makeTestEnv()
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        success: true,
        kiloSessionId: 'ses_12345678901234567890123456',
        history,
      });
    }
  });

  it('DELETE /session/:sessionId revokes cache, clears DO, and deletes descendants child-first', async () => {
    const parentSessionId = 'ses_12345678901234567890123456';
    const childSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    // Recursive CTE
    fns.executeResult.mockResolvedValueOnce({
      rows: [
        { session_id: childSessionId, has_access: true },
        { session_id: parentSessionId, has_access: true },
      ],
    });
    // Rows selected for session.deleted events
    fns.selectResult.mockResolvedValueOnce([
      {
        session_id: parentSessionId,
        parent_session_id: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        created_on_platform: null,
      },
      {
        session_id: childSessionId,
        parent_session_id: parentSessionId,
        organization_id: null,
        git_url: null,
        git_branch: null,
        created_on_platform: null,
      },
    ]);

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
    const env = makeTestEnv();
    const res = await app.fetch(
      new Request(`http://local/session/${parentSessionId}`, {
        method: 'DELETE',
      }),
      env
    );

    expect(res.status).toBe(200);

    const deletedRowsPredicate = fns.selectWhere.mock.calls[0]?.[0];
    if (!(deletedRowsPredicate instanceof SQL)) {
      throw new Error('Expected pre-delete predicate');
    }
    const dialect = new PgDialect();
    const deletedRowsQuery = dialect.sqlToQuery(deletedRowsPredicate);
    expect(deletedRowsQuery.sql).toContain(
      '"cli_sessions_v2"."session_id" in ($1, $2) and "cli_sessions_v2"."kilo_user_id" = $3'
    );
    expect(deletedRowsQuery.params).toEqual([childSessionId, parentSessionId, 'usr_test']);

    expect(fns.deleteWhere).toHaveBeenCalledTimes(2);
    const deletedSessionParams = fns.deleteWhere.mock.calls.map(([predicate]) => {
      if (!(predicate instanceof SQL)) {
        throw new Error('Expected delete predicate');
      }
      return dialect.sqlToQuery(predicate).params;
    });
    expect(deletedSessionParams).toEqual([
      [childSessionId, 'usr_test'],
      [parentSessionId, 'usr_test'],
    ]);
    expect(sessionCache.remove).toHaveBeenNthCalledWith(1, childSessionId);
    expect(sessionCache.remove).toHaveBeenNthCalledWith(2, parentSessionId);
    expect(getSessionIngestDO).toHaveBeenNthCalledWith(1, env, {
      kiloUserId: 'usr_test',
      sessionId: childSessionId,
    });
    expect(getSessionIngestDO).toHaveBeenNthCalledWith(2, env, {
      kiloUserId: 'usr_test',
      sessionId: parentSessionId,
    });
    expect(ingestStub.clear).toHaveBeenCalledTimes(2);
    expect(notifyUserSessionEvent).toHaveBeenNthCalledWith(1, env, 'usr_test', {
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: childSessionId,
        parentSessionId: parentSessionId,
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: null,
        deletedAt: expect.any(String),
      },
    });
    expect(notifyUserSessionEvent).toHaveBeenNthCalledWith(2, env, 'usr_test', {
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: parentSessionId,
        parentSessionId: null,
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: null,
        deletedAt: expect.any(String),
      },
    });
  });

  it('DELETE /session/:sessionId rejects the cascade when a descendant is inaccessible', async () => {
    const parentSessionId = 'ses_12345678901234567890123456';
    const childSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.executeResult.mockResolvedValueOnce({
      rows: [
        { session_id: childSessionId, has_access: false },
        { session_id: parentSessionId, has_access: true },
      ],
    });

    const app = makeApiApp();
    const res = await app.fetch(
      new Request(`http://local/session/${parentSessionId}`, { method: 'DELETE' }),
      makeTestEnv()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'session_not_found' });
    expect(fns.select).not.toHaveBeenCalled();
    expect(fns.delete).not.toHaveBeenCalled();
    expect(fns.transaction).not.toHaveBeenCalled();
  });

  it('POST /session/:sessionId/share returns existing public_id when already shared', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.executeResult.mockResolvedValueOnce({
      rows: [{ public_id: '11111111-1111-1111-1111-111111111111' }],
    });

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      makeTestEnv()
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
    fns.executeResult.mockImplementationOnce(async query => {
      if (!(query instanceof SQL)) {
        throw new Error('Expected share query');
      }
      const generated = new PgDialect().sqlToQuery(query);
      expect(generated.sql).toContain('INNER JOIN "organizations"');
      expect(generated.sql).toContain('"organizations"."deleted_at" IS NULL');
      expect(generated.sql).toContain('"organization_memberships"."kilo_user_id" = $4');
      return { rows: [{ public_id: generated.params[0] }] };
    });

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      makeTestEnv()
    );

    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toMatchObject({ success: true });
    const publicId = (json as { public_id?: unknown }).public_id;
    expect(typeof publicId).toBe('string');
    expect((publicId as string).length).toBeGreaterThan(0);
  });

  it('POST /session/:sessionId/share rejects an authoritative access failure', async () => {
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);
    fns.executeResult.mockResolvedValueOnce({ rows: [] });

    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/session/ses_12345678901234567890123456/share', {
        method: 'POST',
      }),
      makeTestEnv()
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'session_not_found' });
    expect(resolveAccessibleKiloSession).not.toHaveBeenCalled();
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
      makeTestEnv()
    );

    expect(res.status).toBe(200);
    expect(fns.updateSet).toHaveBeenCalled();
  });

  it('GET /sessions/active returns sessions from UserConnectionDO', async () => {
    const connectionStub = {
      getActiveSessions: vi.fn(async () => [
        {
          id: 'ses_12345678901234567890123456',
          status: 'active',
          title: 'My Session',
          connectionId: 'conn-1',
        },
      ]),
    };
    vi.mocked(getUserConnectionDO).mockReturnValue(
      connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
    );

    // The title-overlay query is best-effort: a DB hit with no matching rows
    // keeps the heartbeat titles intact, which is what this test asserts.
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const app = makeApiApp();
    const res = await app.fetch(new Request('http://local/sessions/active', { method: 'GET' }), {
      HYPERDRIVE: { connectionString: 'postgres://test' },
    });

    expect(res.status).toBe(200);
    expect(getUserConnectionDO).toHaveBeenCalledWith(expect.anything(), { kiloUserId: 'usr_test' });
    expect(fns.select).toHaveBeenCalledTimes(1);
    expect(fns.selectWhere).toHaveBeenCalledTimes(1);
    const predicate = fns.selectWhere.mock.calls[0]?.[0];
    expect(predicate).toBeInstanceOf(SQL);
    const dialect = new PgDialect();
    const rendered = dialect.sqlToQuery(predicate as SQL);
    expect(rendered.sql).toContain('"cli_sessions_v2"."kilo_user_id" = $1');
    expect(rendered.sql).toContain('"cli_sessions_v2"."session_id" in ($2)');
    expect(rendered.params).toEqual(['usr_test', 'ses_12345678901234567890123456']);
    expect(await res.json()).toEqual({
      sessions: [
        {
          id: 'ses_12345678901234567890123456',
          status: 'active',
          title: 'My Session',
          connectionId: 'conn-1',
        },
      ],
    });
  });

  it('GET /sessions/active returns empty array when no sessions', async () => {
    const connectionStub = {
      getActiveSessions: vi.fn(async () => []),
    };
    vi.mocked(getUserConnectionDO).mockReturnValue(
      connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
    );

    // No active sessions means the overlay query must not run at all
    // (saves a DB round-trip and avoids unnecessary noise).
    const { db, fns } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db);

    const app = makeApiApp();
    const res = await app.fetch(new Request('http://local/sessions/active', { method: 'GET' }), {
      HYPERDRIVE: { connectionString: 'postgres://test' },
    });

    expect(res.status).toBe(200);
    expect(fns.select).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ sessions: [] });
  });

  describe('GET /sessions/active title overlay', () => {
    const baseHeartbeat = (id: string, title: string) => ({
      id,
      status: 'active',
      title,
      connectionId: `conn-${id}`,
    });

    function setupOverlayTest(overlayRows: Array<{ session_id: string; title: unknown }>) {
      const connectionStub = {
        getActiveSessions: vi.fn(async () => [
          baseHeartbeat('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Heartbeat A'),
          baseHeartbeat('ses_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'Heartbeat B'),
        ]),
      };
      vi.mocked(getUserConnectionDO).mockReturnValue(
        connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
      );
      const { db, fns } = makeDbFakes();
      vi.mocked(getWorkerDb).mockReturnValue(db);
      fns.selectResult.mockResolvedValueOnce(overlayRows as never);
      return { app: makeApiApp(), fns };
    }

    it('overlays a meaningful DB title onto the heartbeat session', async () => {
      const { app, fns } = setupOverlayTest([
        { session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Renamed Title' },
      ]);

      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions).toEqual([
        {
          id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'active',
          title: 'Renamed Title',
          connectionId: 'conn-ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          id: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
          status: 'active',
          title: 'Heartbeat B',
          connectionId: 'conn-ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ]);
      // Overlay query was scoped to the authenticated user.
      const predicate = fns.selectWhere.mock.calls[0]?.[0] as SQL;
      const rendered = new PgDialect().sqlToQuery(predicate);
      expect(rendered.sql).toContain('"cli_sessions_v2"."kilo_user_id" = $1');
      expect(rendered.params).toContain('usr_test');
      expect(rendered.params).toEqual(
        expect.arrayContaining(['ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'])
      );
    });

    it('keeps the heartbeat title when no matching DB row exists', async () => {
      const { app } = setupOverlayTest([]);

      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.map(s => s.title)).toEqual(['Heartbeat A', 'Heartbeat B']);
    });

    it('keeps the heartbeat title when the DB title is null', async () => {
      const { app } = setupOverlayTest([
        { session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', title: null },
      ]);

      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.map(s => s.title)).toEqual(['Heartbeat A', 'Heartbeat B']);
    });

    it('keeps the heartbeat title when the DB title is an empty string', async () => {
      const { app } = setupOverlayTest([
        { session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', title: '' },
      ]);

      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.map(s => s.title)).toEqual(['Heartbeat A', 'Heartbeat B']);
    });

    it('keeps the heartbeat title when the DB title is whitespace-only', async () => {
      const { app } = setupOverlayTest([
        { session_id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', title: '   ' },
      ]);

      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions.map(s => s.title)).toEqual(['Heartbeat A', 'Heartbeat B']);
    });

    it('returns 200 with heartbeat titles when the overlay query throws', async () => {
      const connectionStub = {
        getActiveSessions: vi.fn(async () => [
          baseHeartbeat('ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Heartbeat A'),
        ]),
      };
      vi.mocked(getUserConnectionDO).mockReturnValue(
        connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
      );
      const { db, fns } = makeDbFakes();
      vi.mocked(getWorkerDb).mockReturnValue(db);
      fns.selectResult.mockRejectedValueOnce(new Error('db down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const app = makeApiApp();
      const res = await app.fetch(
        new Request('http://local/sessions/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(body.sessions).toEqual([
        {
          id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          status: 'active',
          title: 'Heartbeat A',
          connectionId: 'conn-ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ]);
      expect(warn).toHaveBeenCalledWith(
        'Failed to overlay active-session titles from Postgres (non-fatal)',
        expect.objectContaining({ kiloUserId: 'usr_test', error: 'db down' })
      );
      warn.mockRestore();
    });
  });

  it('GET /user/cli returns 426 without Upgrade header', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/user/cli', {
        method: 'GET',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: 'Expected WebSocket upgrade' });
  });

  it('GET /user/web returns 426 without Upgrade header', async () => {
    const app = makeApiApp();
    const res = await app.fetch(
      new Request('http://local/user/web', {
        method: 'GET',
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: 'Expected WebSocket upgrade' });
  });

  it('GET /user/cli forwards to DO fetch with /cli path', async () => {
    const stubFetch = vi.fn(async (_req: Request) => new Response(null, { status: 101 }));
    const connectionStub = { fetch: stubFetch };
    vi.mocked(getUserConnectionDO).mockReturnValue(
      connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
    );

    const app = makeApiApp();
    await app.fetch(
      new Request('http://local/user/cli', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(stubFetch).toHaveBeenCalledTimes(1);
    expect(getUserConnectionDO).toHaveBeenCalledWith(expect.anything(), { kiloUserId: 'usr_test' });
    const forwardedReq = stubFetch.mock.calls[0][0];
    const forwardedUrl = new URL(forwardedReq.url);
    expect(forwardedUrl.pathname).toBe('/cli');
  });

  it('GET /user/web forwards to DO fetch with /web path and viewer identity query', async () => {
    const stubFetch = vi.fn(async (_req: Request) => new Response(null, { status: 101 }));
    const connectionStub = { fetch: stubFetch };
    vi.mocked(getUserConnectionDO).mockReturnValue(
      connectionStub as unknown as ReturnType<typeof getUserConnectionDO>
    );

    const app = makeApiApp();
    await app.fetch(
      new Request('http://local/user/web?connectionId=viewer-1', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      }),
      { HYPERDRIVE: { connectionString: 'postgres://test' } }
    );

    expect(stubFetch).toHaveBeenCalledTimes(1);
    expect(getUserConnectionDO).toHaveBeenCalledWith(expect.anything(), { kiloUserId: 'usr_test' });
    const forwardedReq = stubFetch.mock.calls[0][0];
    const forwardedUrl = new URL(forwardedReq.url);
    expect(forwardedUrl.pathname).toBe('/web');
    expect(forwardedUrl.searchParams.get('connectionId')).toBe('viewer-1');
  });

  // -------------------------------------------------------------------------
  // GET /api/instances/active (W3)
  // -------------------------------------------------------------------------

  describe('GET /instances/active', () => {
    it('returns connected instances from the UserConnectionDO', async () => {
      const getConnectedInstances = vi.fn(async () => ({
        instances: [
          { connectionId: 'cli-A', name: 'laptop-A', projectName: 'kilo', version: '0.1.2' },
          { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
        ],
      }));
      vi.mocked(getUserConnectionDO).mockReturnValue({
        getConnectedInstances,
      } as never);

      const app = makeApiApp();
      const res = await app.fetch(
        new Request('http://local/instances/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      expect(getConnectedInstances).toHaveBeenCalledTimes(1);
      expect(await res.json()).toEqual({
        instances: [
          { connectionId: 'cli-A', name: 'laptop-A', projectName: 'kilo', version: '0.1.2' },
          { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
        ],
      });
    });

    it('returns 200 with an empty `instances` array when no CLIs are connected', async () => {
      vi.mocked(getUserConnectionDO).mockReturnValue({
        getConnectedInstances: vi.fn(async () => ({ instances: [] })),
      } as never);

      const app = makeApiApp();
      const res = await app.fetch(
        new Request('http://local/instances/active', { method: 'GET' }),
        makeTestEnv()
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ instances: [] });
    });
  });
});
