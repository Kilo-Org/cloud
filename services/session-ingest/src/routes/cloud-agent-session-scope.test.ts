import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkerUtils from '@kilocode/worker-utils';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
}));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('../dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../ingest/direct-ingest', () => ({ handleDirectIngestRequest: vi.fn() }));
vi.mock('../services/session-access', () => ({ resolveAccessibleKiloSession: vi.fn() }));
vi.mock('../services/user-session-admission', () => ({
  canCreateCliSessionForUser: vi.fn(),
}));
vi.mock('../session-events', () => ({
  mapSessionEventRow: vi.fn(row => ({ id: row.session_id, updatedAt: row.updated_at })),
  notifyUserSessionEvent: vi.fn(),
}));

const workerUtils = vi.hoisted(() => ({ hasOrganizationAccess: vi.fn() }));
vi.mock('@kilocode/worker-utils', async importOriginal => ({
  ...(await importOriginal<typeof WorkerUtils>()),
  hasOrganizationAccess: workerUtils.hasOrganizationAccess,
}));

import { getWorkerDb } from '@kilocode/db/client';
import { cloudAgentSessionScopeHeaders } from '@kilocode/session-ingest-contracts';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import { resolveAccessibleKiloSession } from '../services/session-access';
import { canCreateCliSessionForUser } from '../services/user-session-admission';
import { cloudAgentSessionScopeApi } from './cloud-agent-session-scope';

const rootSessionId = 'ses_12345678901234567890123456';
const childSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
const cloudAgentSessionId = 'cloud-agent-session-1';
const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;

function makeApp() {
  const app = new Hono<{ Bindings: Record<string, unknown>; Variables: { user_id: string } }>();
  app.use('*', async (c, next) => {
    c.set('user_id', 'usr_test');
    await next();
  });
  app.route('/', cloudAgentSessionScopeApi);
  return app;
}

function assertionHeaders() {
  return {
    'Content-Type': 'application/json',
    [cloudAgentSessionScopeHeaders.cloudAgentSessionId]: cloudAgentSessionId,
    [cloudAgentSessionScopeHeaders.rootKiloSessionId]: rootSessionId,
    [cloudAgentSessionScopeHeaders.protocolVersion]: '1',
  };
}

function persistedRow(overrides: Record<string, unknown> = {}) {
  return {
    session_id: childSessionId,
    kilo_user_id: 'usr_test',
    parent_session_id: rootSessionId,
    organization_id: '11111111-1111-4111-8111-111111111111',
    cloud_agent_session_id: null,
    cloud_agent_session_scope_id: cloudAgentSessionId,
    cloud_agent_worktree_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    title: null,
    created_on_platform: 'unknown',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    ...overrides,
  };
}

function makeDb(selectResults: unknown[][], insertResult: unknown[], updateResult: unknown[] = []) {
  const updateSets: unknown[] = [];
  const insertedValues: unknown[] = [];
  const selectConditions: SQL[] = [];

  const select = {
    from: vi.fn(() => select),
    where: vi.fn((condition: SQL) => {
      selectConditions.push(condition);
      return select;
    }),
    limit: vi.fn(() => select),
    for: vi.fn(async () => selectResults.shift() ?? []),
    then: (resolve: (rows: unknown[]) => unknown) => resolve(selectResults.shift() ?? []),
  };
  const update = {
    set: vi.fn(values => {
      updateSets.push(values);
      return update;
    }),
    where: vi.fn(() => update),
    returning: vi.fn(async () => updateResult),
    then: vi.fn(resolve => resolve(undefined)),
  };
  const insert = {
    values: vi.fn(values => {
      insertedValues.push(values);
      return insert;
    }),
    onConflictDoNothing: vi.fn(() => insert),
    returning: vi.fn(async () => insertResult),
  };
  const tx = {
    select: vi.fn(() => select),
    update: vi.fn(() => update),
    insert: vi.fn(() => insert),
  };
  const db = {
    transaction: vi.fn(async callback => callback(tx)),
  };
  return { db, insertedValues, updateSets, selectConditions };
}

describe('Cloud Agent session scope routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    workerUtils.hasOrganizationAccess.mockResolvedValue(true);
    vi.mocked(canCreateCliSessionForUser).mockResolvedValue(true);
  });

  it('rejects a blocked or missing user before locking the root or inserting a child', async () => {
    const { db, insertedValues } = makeDb([], []);
    vi.mocked(canCreateCliSessionForUser).mockResolvedValueOnce(false);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(403);
    expect(insertedValues).toHaveLength(0);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    expect(workerUtils.hasOrganizationAccess).not.toHaveBeenCalled();
  });

  it('rejects an incomplete or invalid session scope assertion before database access', async () => {
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const headers = assertionHeaders();
    headers[cloudAgentSessionScopeHeaders.protocolVersion] = '2';

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects a late descendant registration when its locked root belongs to a deleting worktree', async () => {
    const { db, insertedValues } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentSessionScopeId: cloudAgentSessionId,
            worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
          },
        ],
        [{ started: '2026-08-27 01:00:00+00' }],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(insertedValues).toEqual([]);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
  });

  it('atomically heals the root and creates a session-scoped child', async () => {
    const child = persistedRow();
    const { db, insertedValues, updateSets } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: child.organization_id,
            cloudAgentSessionScopeId: null,
          },
        ],
      ],
      [child]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(updateSets).toContainEqual({ cloud_agent_session_scope_id: cloudAgentSessionId });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        session_id: childSessionId,
        parent_session_id: rootSessionId,
        cloud_agent_session_scope_id: cloudAgentSessionId,
        cloud_agent_session_id: null,
      })
    );
    expect(putValidated).toHaveBeenCalledWith({
      sessionId: childSessionId,
      organizationId: child.organization_id,
      cloudAgentSessionScopeId: cloudAgentSessionId,
    });
  });

  it('persists engine-created child lineage before its first turn when public bootstrap won the race', async () => {
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const child = persistedRow({
      organization_id: null,
      parent_session_id: null,
      cloud_agent_session_scope_id: null,
      cloud_agent_worktree_id: null,
      status: null,
    });
    const linked = {
      ...child,
      parent_session_id: rootSessionId,
      cloud_agent_session_scope_id: cloudAgentSessionId,
      cloud_agent_worktree_id: worktreeId,
    };
    const { db, updateSets } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentSessionScopeId: cloudAgentSessionId,
            worktreeId,
          },
        ],
        [],
        [child],
      ],
      [],
      [linked]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId, parentSessionId: rootSessionId }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(updateSets).toContainEqual({
      parent_session_id: rootSessionId,
      cloud_agent_session_scope_id: cloudAgentSessionId,
      cloud_agent_worktree_id: worktreeId,
    });
    expect(putValidated).toHaveBeenCalledWith({
      sessionId: childSessionId,
      organizationId: null,
      cloudAgentSessionScopeId: cloudAgentSessionId,
    });
  });

  it.each([
    ['organization', { organization_id: '22222222-2222-4222-8222-222222222222' }],
    ['root scope', { cloud_agent_session_scope_id: 'another-root' }],
    ['worktree', { cloud_agent_worktree_id: 'worktree_22222222-2222-4222-8222-222222222222' }],
    ['cloud root', { cloud_agent_session_id: 'another-root' }],
    ['parent', { parent_session_id: 'ses_cccccccccccccccccccccccccc' }],
  ])('refuses to overwrite established %s when adopting an orphan', async (_name, overrides) => {
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const child = persistedRow({
      parent_session_id: null,
      cloud_agent_session_scope_id: null,
      ...overrides,
    });
    const { db, updateSets } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId,
            cloudAgentSessionScopeId: cloudAgentSessionId,
            worktreeId,
          },
        ],
        [],
        [child],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId, parentSessionId: rootSessionId }),
      }),
      env
    );
    expect(response.status).toBe(409);
    expect(updateSets).toEqual([]);
    expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
  });

  it('requires a nested parent in the same authenticated owner, organization, root scope, and worktree', async () => {
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const parentSessionId = 'ses_cccccccccccccccccccccccccc';
    const { db, insertedValues, selectConditions } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId,
            cloudAgentSessionScopeId: cloudAgentSessionId,
            worktreeId,
          },
        ],
        [],
        [],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId, parentSessionId }),
      }),
      env
    );
    expect(response.status).toBe(409);
    expect(insertedValues).toEqual([]);
    const condition = selectConditions.at(-1);
    if (!condition) throw new Error('Expected parent authorization');
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.params).toEqual([
      parentSessionId,
      'usr_test',
      cloudAgentSessionId,
      organizationId,
      worktreeId,
    ]);
    expect(query.sql).toContain('"kilo_user_id"');
    expect(query.sql).toContain('"organization_id"');
    expect(query.sql).toContain('"cloud_agent_session_scope_id"');
    expect(query.sql).toContain('"cloud_agent_worktree_id"');
  });

  it('does not create a child when the asserted root belongs to another user or root scope', async () => {
    const { db, insertedValues, selectConditions } = makeDb([[]], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId, parentSessionId: rootSessionId }),
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(insertedValues).toEqual([]);
    const query = new PgDialect().sqlToQuery(selectConditions[0]);
    expect(query.params).toEqual(
      expect.arrayContaining([rootSessionId, 'usr_test', cloudAgentSessionId])
    );
    expect(query.sql).toContain('"kilo_user_id"');
    expect(query.sql).toContain('"cloud_agent_session_id"');
  });

  it('heals missing worktree membership for an already-authorized legacy child without changing its root', async () => {
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const child = persistedRow({ organization_id: null });
    const { db, updateSets } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentSessionScopeId: cloudAgentSessionId,
            worktreeId,
          },
        ],
        [],
        [child],
      ],
      [],
      [{ ...child, cloud_agent_worktree_id: worktreeId }]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({
      putValidated: async () => undefined,
    } as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(updateSets).toEqual([{ cloud_agent_worktree_id: worktreeId }]);
  });

  it('does not claim an existing unmarked session', async () => {
    const { db } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentSessionScopeId: cloudAgentSessionId,
          },
        ],
        [persistedRow({ cloud_agent_session_scope_id: null })],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(409);
  });

  it('treats an existing child in the same session scope as an idempotent bootstrap', async () => {
    const existing = persistedRow({ organization_id: null, cloud_agent_worktree_id: null });
    const { db } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: null,
            cloudAgentSessionScopeId: cloudAgentSessionId,
          },
        ],
        [existing],
      ],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: childSessionId }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(putValidated).toHaveBeenCalledWith(
      expect.objectContaining({ cloudAgentSessionScopeId: cloudAgentSessionId })
    );
  });

  it('requires the asserted session scope during child ingest authorization', async () => {
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValue({
      kiloSessionId: childSessionId,
      organizationId: null,
      cloudAgentSessionScopeId: cloudAgentSessionId,
    });
    vi.mocked(handleDirectIngestRequest).mockResolvedValue({
      status: 200,
      body: { success: true },
    } as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/ingest?v=2`, {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(resolveAccessibleKiloSession).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_test',
      kiloSessionId: childSessionId,
      expectedCloudAgentSessionScopeId: cloudAgentSessionId,
    });
  });
});
