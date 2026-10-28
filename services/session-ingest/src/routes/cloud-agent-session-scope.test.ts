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
vi.mock('../services/cloud-agent-worktree-scope', async importOriginal => ({
  ...(await importOriginal<typeof CloudAgentWorktreeScopeModule>()),
  resolveScopedChildSession: vi.fn(),
  resolveScopedCreateParent: vi.fn(),
}));
vi.mock('../services/session-export', () => ({ getSessionExport: vi.fn() }));
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
import {
  cloudAgentSessionScopeHeaders,
  cloudAgentSessionScopeV2Headers,
} from '@kilocode/session-ingest-contracts';
import { getSessionAccessCacheDO } from '../dos/SessionAccessCacheDO';
import { handleDirectIngestRequest } from '../ingest/direct-ingest';
import {
  resolveScopedChildSession,
  resolveScopedCreateParent,
} from '../services/cloud-agent-worktree-scope';
import type * as CloudAgentWorktreeScopeModule from '../services/cloud-agent-worktree-scope';
import { getSessionExport } from '../services/session-export';
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

function queryOf(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
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
  const updateConditions: SQL[] = [];
  const forConditions: SQL[] = [];
  const insertedValues: unknown[] = [];
  const selectConditions: SQL[] = [];

  const select = {
    from: vi.fn(() => select),
    where: vi.fn((condition: SQL) => {
      selectConditions.push(condition);
      return select;
    }),
    limit: vi.fn(() => select),
    for: vi.fn(async () => {
      const condition = selectConditions.at(-1);
      if (condition) forConditions.push(condition);
      return selectResults.shift() ?? [];
    }),
    then: (resolve: (rows: unknown[]) => unknown) => resolve(selectResults.shift() ?? []),
  };
  const update = {
    set: vi.fn(values => {
      updateSets.push(values);
      return update;
    }),
    where: vi.fn((condition: SQL) => {
      updateConditions.push(condition);
      return update;
    }),
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
    select: vi.fn(() => select),
    update: vi.fn(() => update),
  };
  return { db, insertedValues, updateSets, updateConditions, forConditions, selectConditions };
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

  it('rejects an incomplete protocol v2 assertion before database access', async () => {
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
    expect(getWorkerDb).not.toHaveBeenCalled();
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

  it.each([undefined, rootSessionId])(
    'creates a new scoped child with untrusted parent %s',
    async parentSessionId => {
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
          body: JSON.stringify({ sessionId: childSessionId, parentSessionId }),
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
    }
  );

  it.each([
    { organizationId: null, existingOrganizationId: null },
    { organizationId: '11111111-1111-4111-8111-111111111111', existingOrganizationId: null },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      existingOrganizationId: '11111111-1111-4111-8111-111111111111',
    },
  ])(
    'adopts a public-sync-first orphan with trusted lineage from $existingOrganizationId into $organizationId',
    async ({ organizationId, existingOrganizationId }) => {
      const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
      const child = persistedRow({
        organization_id: existingOrganizationId,
        parent_session_id: null,
        cloud_agent_session_scope_id: null,
        title: 'Already synced child',
        git_url: 'https://github.com/acme/repo',
        status: 'idle',
      });
      const linked = {
        ...child,
        organization_id: organizationId,
        parent_session_id: rootSessionId,
        cloud_agent_session_scope_id: cloudAgentSessionId,
        cloud_agent_worktree_id: worktreeId,
      };
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
        [],
        [linked]
      );
      vi.mocked(getWorkerDb).mockReturnValue(db as never);
      const putValidated = vi.fn(async () => undefined);
      vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

      const response = await makeApp().fetch(
        new Request('http://local/session', {
          method: 'POST',
          headers: {
            ...assertionHeaders(),
            [cloudAgentSessionScopeHeaders.trustedLineage]: '1',
          },
          body: JSON.stringify({ sessionId: childSessionId, parentSessionId: rootSessionId }),
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(updateSets).toEqual([
        {
          parent_session_id: rootSessionId,
          cloud_agent_session_scope_id: cloudAgentSessionId,
          cloud_agent_worktree_id: worktreeId,
          ...(existingOrganizationId !== organizationId ? { organization_id: organizationId } : {}),
        },
      ]);
      expect(putValidated).toHaveBeenCalledWith({
        sessionId: childSessionId,
        organizationId,
        cloudAgentSessionScopeId: cloudAgentSessionId,
      });
    }
  );

  it.each([
    { organizationId: null, title: null, status: null },
    {
      organizationId: '11111111-1111-4111-8111-111111111111',
      title: 'Unrelated populated CLI session',
      status: 'idle',
    },
  ])(
    'rejects untrusted adoption with a supplied parent in scope $organizationId',
    async ({ organizationId, title, status }) => {
      const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
      const child = persistedRow({
        organization_id: organizationId,
        parent_session_id: null,
        cloud_agent_session_scope_id: null,
        title,
        status,
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
        [],
        [{ ...child, parent_session_id: rootSessionId, cloud_agent_worktree_id: worktreeId }]
      );
      vi.mocked(getWorkerDb).mockReturnValue(db as never);
      vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated: vi.fn() } as never);

      const response = await makeApp().fetch(
        new Request('http://local/session', {
          method: 'POST',
          headers: assertionHeaders(),
          body: JSON.stringify({ sessionId: childSessionId, parentSessionId: rootSessionId }),
        }),
        env
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ success: false, error: 'session_scope_conflict' });
      expect(updateSets).toEqual([]);
      expect(getSessionAccessCacheDO).not.toHaveBeenCalled();
    }
  );

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
        headers: {
          ...assertionHeaders(),
          [cloudAgentSessionScopeHeaders.trustedLineage]: '1',
        },
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

  it('bootstraps a grandchild under an existing parent in the authorized root scope', async () => {
    const grandchildSessionId = 'ses_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const child = persistedRow();
    const { db, insertedValues, selectConditions } = makeDb(
      [
        [
          {
            sessionId: rootSessionId,
            organizationId: child.organization_id,
            cloudAgentSessionScopeId: cloudAgentSessionId,
          },
        ],
        [{ sessionId: childSessionId }],
      ],
      [persistedRow({ session_id: grandchildSessionId, parent_session_id: childSessionId })]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);
    const response = await makeApp().fetch(
      new Request('http://local/session', {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ sessionId: grandchildSessionId, parentSessionId: childSessionId }),
      }),
      env
    );
    expect(response.status).toBe(200);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        session_id: grandchildSessionId,
        parent_session_id: childSessionId,
        cloud_agent_session_scope_id: cloudAgentSessionId,
        organization_id: child.organization_id,
        cloud_agent_session_id: null,
      })
    );
    expect(new PgDialect().sqlToQuery(selectConditions[1]).params).toEqual([
      childSessionId,
      'usr_test',
      cloudAgentSessionId,
      child.organization_id,
    ]);
    expect(putValidated).toHaveBeenCalledWith({
      sessionId: grandchildSessionId,
      organizationId: child.organization_id,
      cloudAgentSessionScopeId: cloudAgentSessionId,
    });
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

  it('denies unrelated sessions through the existing scoped ingest authorization', async () => {
    vi.mocked(resolveAccessibleKiloSession).mockResolvedValue(null);
    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/ingest?v=2`, {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ data: [] }),
      }),
      env
    );
    expect(response.status).toBe(404);
    expect(resolveAccessibleKiloSession).toHaveBeenCalledWith(expect.anything(), {
      kiloUserId: 'usr_test',
      kiloSessionId: childSessionId,
      expectedCloudAgentSessionScopeId: cloudAgentSessionId,
    });
    expect(handleDirectIngestRequest).not.toHaveBeenCalled();
  });

  it.each([childSessionId, 'ses_ABCDEFGHIJKLMNOPQRSTUVWXYZ'])(
    'requires the asserted session scope during descendant %s ingest authorization',
    async sessionId => {
      vi.mocked(resolveAccessibleKiloSession).mockResolvedValue({
        kiloSessionId: sessionId,
        organizationId: null,
        cloudAgentSessionScopeId: cloudAgentSessionId,
      });
      vi.mocked(handleDirectIngestRequest).mockResolvedValue({
        status: 200,
        body: { success: true },
      } as never);

      const response = await makeApp().fetch(
        new Request(`http://local/session/${sessionId}/ingest?v=2`, {
          method: 'POST',
          headers: assertionHeaders(),
          body: JSON.stringify({ data: [] }),
        }),
        env
      );

      expect(response.status).toBe(200);
      expect(resolveAccessibleKiloSession).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'usr_test',
        kiloSessionId: sessionId,
        expectedCloudAgentSessionScopeId: cloudAgentSessionId,
      });
    }
  );
});

describe('Cloud Agent session scope v2 routes', () => {
  const v2WorktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
  const v2OrganizationId = '33333333-3333-4333-8333-333333333333';
  const memberRootId = rootSessionId;

  function v2Headers(overrides: Record<string, string> = {}) {
    return {
      'Content-Type': 'application/json',
      [cloudAgentSessionScopeHeaders.protocolVersion]: '2',
      [cloudAgentSessionScopeV2Headers.worktreeId]: v2WorktreeId,
      [cloudAgentSessionScopeV2Headers.expectedOrganization]: v2OrganizationId,
      [cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds]: memberRootId,
      ...overrides,
    };
  }

  function createRequest(headers: Record<string, string>, parentSessionId = memberRootId) {
    return new Request('http://local/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: childSessionId, parentSessionId }),
    });
  }

  function rootParentRow() {
    return {
      sessionId: memberRootId,
      parentSessionId: null,
      organizationId: v2OrganizationId,
      cloudAgentSessionId: 'workspace_root',
      cloudAgentSessionScopeId: null,
      cloudAgentWorktreeId: v2WorktreeId,
    };
  }

  function expectedLockSql(organizationId: string | null): string {
    return organizationId === null
      ? `("cli_sessions_v2"."session_id" = $1 and ("cli_sessions_v2"."kilo_user_id" = $2 and "cli_sessions_v2"."organization_id" is null and "cli_sessions_v2"."cloud_agent_worktree_id" = $3) and "cli_sessions_v2"."parent_session_id" is null)`
      : `("cli_sessions_v2"."session_id" = $1 and ("cli_sessions_v2"."kilo_user_id" = $2 and "cli_sessions_v2"."organization_id" = $3 and "cli_sessions_v2"."cloud_agent_worktree_id" = $4) and "cli_sessions_v2"."parent_session_id" is null)`;
  }

  function expectedTitleWhereSql(organizationId: string | null): string {
    return organizationId === null
      ? `("cli_sessions_v2"."session_id" = $1 and "cli_sessions_v2"."kilo_user_id" = $2 and (("cli_sessions_v2"."kilo_user_id" = $3 and "cli_sessions_v2"."organization_id" is null and "cli_sessions_v2"."cloud_agent_worktree_id" = $4) and "cli_sessions_v2"."cloud_agent_session_scope_id" = $5))`
      : `("cli_sessions_v2"."session_id" = $1 and "cli_sessions_v2"."kilo_user_id" = $2 and (("cli_sessions_v2"."kilo_user_id" = $3 and "cli_sessions_v2"."organization_id" = $4 and "cli_sessions_v2"."cloud_agent_worktree_id" = $5) and "cli_sessions_v2"."cloud_agent_session_scope_id" = $6))`;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(canCreateCliSessionForUser).mockResolvedValue(true);
  });

  it.each([
    ['worktree id', cloudAgentSessionScopeV2Headers.worktreeId],
    ['expected organization', cloudAgentSessionScopeV2Headers.expectedOrganization],
    ['member roots', cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds],
  ])('rejects protocol v2 missing the %s before database access', async (_label, header) => {
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const headers = v2Headers();
    delete headers[header];

    const response = await makeApp().fetch(createRequest(headers), env);

    expect(response.status).toBe(400);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('rejects protocol v2 with more than 32 member roots before database access', async () => {
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const roots = Array.from(
      { length: 33 },
      (_, index) => `ses_${String(index).padStart(26, '0')}`
    );

    const response = await makeApp().fetch(
      createRequest(
        v2Headers({ [cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds]: roots.join(',') })
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('rejects a member-root header over 4096 bytes that de-duplicates to one root before database access', async () => {
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const repeated = Array.from({ length: 140 }, () => memberRootId).join(',');
    expect(repeated.length).toBeGreaterThan(4096);

    const response = await makeApp().fetch(
      createRequest(
        v2Headers({ [cloudAgentSessionScopeV2Headers.memberRootKiloSessionIds]: repeated })
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('ignores an oversized Cloud Agent session header when the v2 assertion fields are valid', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({ kind: 'denied' });
    const { db } = makeDb([[]], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      createRequest(
        v2Headers({
          [cloudAgentSessionScopeHeaders.cloudAgentSessionId]: `workspace_${'a'.repeat(5000)}`,
        })
      ),
      env
    );

    expect(response.status).toBe(409);
    expect(getWorkerDb).toHaveBeenCalled();
  });

  it('rejects protocol v1 assertions on the scoped export and title routes', async () => {
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const exportResponse = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/export`, {
        method: 'GET',
        headers: assertionHeaders(),
      }),
      env
    );
    const titleResponse = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/title`, {
        method: 'POST',
        headers: assertionHeaders(),
        body: JSON.stringify({ title: 'Renamed', generated: false }),
      }),
      env
    );

    expect(exportResponse.status).toBe(400);
    expect(titleResponse.status).toBe(400);
    expect(getWorkerDb).not.toHaveBeenCalled();
  });

  it('accepts a complete protocol v2 assertion and applies the v2 predicate', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({ kind: 'denied' });
    const { db } = makeDb([[]], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(createRequest(v2Headers()), env);

    expect(response.status).toBe(409);
    expect(resolveScopedCreateParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        parentSessionId: memberRootId,
        scope: expect.objectContaining({
          worktreeId: v2WorktreeId,
          organizationId: v2OrganizationId,
          memberRootKiloSessionIds: [memberRootId],
        }),
      })
    );
  });

  it('creates a child under a member-root parent and copies the root scope id', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({
      kind: 'ok',
      parent: rootParentRow(),
      memberRoot: {
        sessionId: memberRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: null,
      },
      memberRootScopeId: 'workspace_root',
    });
    const created = persistedRow({
      parent_session_id: memberRootId,
      organization_id: v2OrganizationId,
      cloud_agent_session_scope_id: 'workspace_root',
      cloud_agent_worktree_id: v2WorktreeId,
    });
    const { db, insertedValues, forConditions } = makeDb(
      [[{ sessionId: memberRootId }], []],
      [created]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(createRequest(v2Headers()), env);

    expect(response.status).toBe(200);
    expect(forConditions).toHaveLength(1);
    expect(queryOf(forConditions[0]).sql).toBe(expectedLockSql(v2OrganizationId));
    expect(queryOf(forConditions[0]).params).toEqual([
      memberRootId,
      'usr_test',
      v2OrganizationId,
      v2WorktreeId,
    ]);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        session_id: childSessionId,
        parent_session_id: memberRootId,
        organization_id: v2OrganizationId,
        cloud_agent_session_scope_id: 'workspace_root',
        cloud_agent_worktree_id: v2WorktreeId,
        cloud_agent_session_id: null,
      })
    );
    expect(putValidated).toHaveBeenCalledWith({
      sessionId: childSessionId,
      organizationId: v2OrganizationId,
      cloudAgentSessionScopeId: 'workspace_root',
    });
  });

  it('locks the member root before checking worktree deletion', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({
      kind: 'ok',
      parent: rootParentRow(),
      memberRoot: {
        sessionId: memberRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: 'workspace_root',
      },
      memberRootScopeId: 'workspace_root',
    });
    const { db, insertedValues, forConditions, selectConditions } = makeDb(
      [[{ sessionId: memberRootId }], [{ started: '2026-01-01T00:00:00.000Z' }]],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(createRequest(v2Headers()), env);

    expect(response.status).toBe(404);
    expect(insertedValues).toHaveLength(0);
    expect(forConditions).toHaveLength(1);
    expect(queryOf(forConditions[0]).sql).toBe(expectedLockSql(v2OrganizationId));
    const lockIndex = selectConditions.indexOf(forConditions[0]);
    const deletionIndex = selectConditions.findIndex(condition =>
      queryOf(condition).sql.includes('"cloud_agent_worktrees"')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(deletionIndex).toBeGreaterThan(lockIndex);
  });

  it('rejects an unmatched existing orphan even with the trusted lineage header', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({
      kind: 'ok',
      parent: rootParentRow(),
      memberRoot: {
        sessionId: memberRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_root',
        cloudAgentSessionScopeId: 'workspace_root',
      },
      memberRootScopeId: 'workspace_root',
    });
    const orphan = persistedRow({
      parent_session_id: null,
      organization_id: null,
      cloud_agent_session_scope_id: null,
      cloud_agent_worktree_id: null,
    });
    const { db, updateSets, updateConditions } = makeDb(
      [[{ sessionId: memberRootId }], [], [orphan]],
      [],
      []
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      createRequest(v2Headers({ [cloudAgentSessionScopeHeaders.trustedLineage]: '1' })),
      env
    );

    expect(response.status).toBe(409);
    expect(updateSets).toHaveLength(0);
    expect(updateConditions).toHaveLength(0);
  });

  it('copies the actual parent child scope, not the serving member', async () => {
    const parentChildId = 'ses_55555555555555555555555555';
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({
      kind: 'ok',
      parent: {
        sessionId: parentChildId,
        parentSessionId: memberRootId,
        organizationId: v2OrganizationId,
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: 'workspace_A',
        cloudAgentWorktreeId: v2WorktreeId,
      },
      memberRoot: {
        sessionId: memberRootId,
        parentSessionId: null,
        cloudAgentSessionId: 'workspace_A',
        cloudAgentSessionScopeId: 'workspace_A',
      },
      memberRootScopeId: 'workspace_A',
    });
    const created = persistedRow({
      parent_session_id: parentChildId,
      organization_id: v2OrganizationId,
      cloud_agent_session_scope_id: 'workspace_A',
      cloud_agent_worktree_id: v2WorktreeId,
    });
    const { db, insertedValues } = makeDb([[{ sessionId: memberRootId }], []], [created]);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    const putValidated = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ putValidated } as never);

    const response = await makeApp().fetch(
      createRequest(
        v2Headers({
          [cloudAgentSessionScopeHeaders.cloudAgentSessionId]: 'workspace_B',
        }),
        parentChildId
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(resolveScopedCreateParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: expect.objectContaining({ memberRootKiloSessionIds: [memberRootId] }),
      })
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        session_id: childSessionId,
        parent_session_id: parentChildId,
        organization_id: v2OrganizationId,
        cloud_agent_session_scope_id: 'workspace_A',
        cloud_agent_worktree_id: v2WorktreeId,
      })
    );
  });

  it('denies v2 create when the parent is outside the asserted scope', async () => {
    vi.mocked(resolveScopedCreateParent).mockResolvedValue({ kind: 'denied' });
    const { db, insertedValues } = makeDb([[]], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(createRequest(v2Headers()), env);

    expect(response.status).toBe(409);
    expect(insertedValues).toHaveLength(0);
  });

  it('allows v2 ingest only after the child predicate passes', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({
      kind: 'ok',
      rootScopeId: 'workspace_root',
    });
    vi.mocked(handleDirectIngestRequest).mockResolvedValue({
      status: 200,
      body: { success: true },
    } as never);
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/ingest?v=2`, {
        method: 'POST',
        headers: v2Headers(),
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(handleDirectIngestRequest).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: childSessionId, kiloUserId: 'usr_test' })
    );
  });

  it('denies v2 ingest when the child predicate fails', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({ kind: 'denied' });
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/ingest?v=2`, {
        method: 'POST',
        headers: v2Headers(),
        body: JSON.stringify({ data: [] }),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(handleDirectIngestRequest).not.toHaveBeenCalled();
  });

  it('exports a child only after the child predicate passes', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({
      kind: 'ok',
      rootScopeId: 'workspace_root',
    });
    vi.mocked(getSessionExport).mockResolvedValue({
      status: 'ok',
      stream: new Blob(['{"events":[]}']).stream(),
    });
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/export`, {
        method: 'GET',
        headers: v2Headers(),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(getSessionExport).toHaveBeenCalledWith(env, childSessionId, 'usr_test');
  });

  it('denies v2 export when the child predicate fails without reading the export', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({ kind: 'denied' });
    const { db } = makeDb([], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/export`, {
        method: 'GET',
        headers: v2Headers(),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(getSessionExport).not.toHaveBeenCalled();
  });

  it('renames a child only after the child predicate passes', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({
      kind: 'ok',
      rootScopeId: 'workspace_root',
    });
    const existing = persistedRow({
      title: null,
      cloud_agent_worktree_id: v2WorktreeId,
      organization_id: v2OrganizationId,
    });
    const { db, updateSets, updateConditions } = makeDb(
      [[existing]],
      [],
      [{ ...existing, title: 'Renamed' }]
    );
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/title`, {
        method: 'POST',
        headers: v2Headers(),
        body: JSON.stringify({ title: 'Renamed', generated: false }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(updateSets).toContainEqual({ title: 'Renamed', updated_at: existing.updated_at });
    expect(updateConditions).toHaveLength(1);
    expect(queryOf(updateConditions[0]).sql).toBe(expectedTitleWhereSql(v2OrganizationId));
    expect(queryOf(updateConditions[0]).params).toEqual([
      childSessionId,
      'usr_test',
      'usr_test',
      v2OrganizationId,
      v2WorktreeId,
      'workspace_root',
    ]);
  });

  it('scopes a personal title update by owner, worktree, and root scope id', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({
      kind: 'ok',
      rootScopeId: 'workspace_root',
    });
    const existing = persistedRow({
      title: null,
      organization_id: null,
      cloud_agent_worktree_id: v2WorktreeId,
    });
    const { db, updateConditions } = makeDb([[existing]], [], [{ ...existing, title: 'Renamed' }]);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/title`, {
        method: 'POST',
        headers: v2Headers({ [cloudAgentSessionScopeV2Headers.expectedOrganization]: 'personal' }),
        body: JSON.stringify({ title: 'Renamed', generated: false }),
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(updateConditions).toHaveLength(1);
    expect(queryOf(updateConditions[0]).sql).toBe(expectedTitleWhereSql(null));
    expect(queryOf(updateConditions[0]).params).toEqual([
      childSessionId,
      'usr_test',
      'usr_test',
      v2WorktreeId,
      'workspace_root',
    ]);
  });

  it('denies v2 title when the child predicate fails', async () => {
    vi.mocked(resolveScopedChildSession).mockResolvedValue({ kind: 'denied' });
    const { db, updateSets } = makeDb([], [], []);
    vi.mocked(getWorkerDb).mockReturnValue(db as never);

    const response = await makeApp().fetch(
      new Request(`http://local/session/${childSessionId}/title`, {
        method: 'POST',
        headers: v2Headers(),
        body: JSON.stringify({ title: 'Renamed', generated: false }),
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(updateSets).toHaveLength(0);
  });
});
