import type * as DbClient from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  },
}));
vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClient>();
  return { ...actual, getWorkerDb: vi.fn() };
});
vi.mock('../../src/dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));
vi.mock('../../src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(() => ({ isDeleted: async () => false, clear: async () => undefined })),
}));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(() => ({ remove: async () => undefined })),
}));
vi.mock('../../src/services/user-session-admission', () => ({
  canCreateCliSessionForUser: async () => true,
}));

import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import { getUserConnectionDO } from '../../src/dos/UserConnectionDO';
import type { Env } from '../../src/env';
import { api, type ApiContext } from '../../src/routes/api';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';

const owner = 'oauth/workspace-update-owner';
const otherOwner = 'oauth/workspace-update-other';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const parentOrganizationId = '33333333-3333-4333-8333-333333333333';
const sessionId = 'ses_11111111111111111111111111';
const oldActivity = '2026-01-01T00:00:00.000Z';
const notifySessionEvent = vi.fn(async () => ({ delivered: 2 }));
const notifyWorkspaceUpdates = vi.fn(async (_worktreeIds: readonly string[]) => ({ delivered: 2 }));
const pending: Promise<unknown>[] = [];
let client: ReturnType<typeof createDrizzleClient>;
let rpc: SessionIngestRPC;
const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as Env;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Workspace update tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  vi.mocked(getUserConnectionDO).mockReturnValue({
    notifySessionEvent,
    notifyWorkspaceUpdates,
  } as never);
  rpc = new SessionIngestRPC(
    { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as never,
    env
  );
  await client.db.execute(sql`
    CREATE TEMP TABLE cloud_agent_worktrees (
      LIKE public.cloud_agent_worktrees INCLUDING DEFAULTS INCLUDING INDEXES
    );
    CREATE TEMP TABLE cli_sessions_v2 (
      LIKE public.cli_sessions_v2 INCLUDING DEFAULTS INCLUDING INDEXES
    );
    CREATE TEMP TABLE organizations (
      id uuid PRIMARY KEY,
      parent_organization_id uuid,
      deleted_at timestamptz
    );
    CREATE TEMP TABLE organization_memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      kilo_user_id text NOT NULL,
      role text NOT NULL
    )
  `);
});

afterAll(async () => {
  await Promise.all(pending);
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await Promise.all(pending);
  pending.length = 0;
  notifySessionEvent.mockClear();
  notifyWorkspaceUpdates.mockClear();
  await client.db.execute(sql`
    TRUNCATE pg_temp.cli_sessions_v2, pg_temp.cloud_agent_worktrees,
      pg_temp.organizations, pg_temp.organization_memberships
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.organizations (id, parent_organization_id)
    VALUES (${parentOrganizationId}, NULL), (${organizationId}, ${parentOrganizationId})
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id, last_activity_at)
    VALUES (${worktreeId}, ${owner}, ${oldActivity})
  `);
});

async function notify(
  organization: string | null,
  userId = owner,
  worktreeIds?: readonly string[]
) {
  const app = new Hono<ApiContext>();
  app.use('*', async (c, next) => {
    c.set('user_id', userId);
    await next();
  });
  app.route('/api', api);
  return app.fetch(
    new Request(`http://local/api/workspaces/${worktreeIds ? 'notify' : `${worktreeId}/notify`}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: organization,
        ...(worktreeIds ? { worktreeIds } : {}),
      }),
    }),
    env
  );
}

async function readWorkspace() {
  const result = await client.db.execute(sql`SELECT * FROM pg_temp.cloud_agent_worktrees`);
  return result.rows[0];
}

describe.each(['single', 'batch'] as const)('%s workspace update access boundaries', mode => {
  const request = (organization: string | null, userId = owner) =>
    notify(organization, userId, mode === 'batch' ? [worktreeId] : undefined);

  it('notifies owned personal tombstones without changing the workspace', async () => {
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees
      SET deletion_started_at = now(), deletion_completed_at = now()
    `);
    const before = await readWorkspace();
    const response = await request(null);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: 2 });
    expect(notifyWorkspaceUpdates).toHaveBeenCalledWith([worktreeId]);
    expect(await readWorkspace()).toEqual(before);
  });

  it('rejects another owner and an inexact organization scope', async () => {
    expect((await request(null, otherOwner)).status).toBe(404);
    expect((await request(organizationId)).status).toBe(404);
    expect(notifyWorkspaceUpdates).not.toHaveBeenCalled();
  });

  it('requires a current membership in the exact active organization', async () => {
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees SET organization_id = ${organizationId}
    `);
    expect((await request(organizationId)).status).toBe(404);
    await client.db.execute(sql`
      INSERT INTO pg_temp.organization_memberships (organization_id, kilo_user_id, role)
      VALUES (${organizationId}, ${owner}, 'member')
    `);
    expect((await request(null)).status).toBe(404);
    expect((await request(organizationId)).status).toBe(200);
    await client.db.execute(sql`
      UPDATE pg_temp.organizations SET deleted_at = now() WHERE id = ${organizationId}
    `);
    expect((await request(organizationId)).status).toBe(404);
    expect(notifyWorkspaceUpdates).toHaveBeenCalledTimes(1);
  });

  it('allows inherited parent access only for an eligible role and active parent', async () => {
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees SET organization_id = ${organizationId}
    `);
    await client.db.execute(sql`
      INSERT INTO pg_temp.organization_memberships (organization_id, kilo_user_id, role)
      VALUES (${parentOrganizationId}, ${owner}, 'member')
    `);
    expect((await request(organizationId)).status).toBe(404);
    await client.db.execute(sql`UPDATE pg_temp.organization_memberships SET role = 'owner'`);
    expect((await request(organizationId)).status).toBe(200);
    await client.db.execute(sql`
      UPDATE pg_temp.organizations SET deleted_at = now() WHERE id = ${parentOrganizationId}
    `);
    expect((await request(organizationId)).status).toBe(404);
    expect(notifyWorkspaceUpdates).toHaveBeenCalledTimes(1);
  });
});

describe('workspace update batch authorization', () => {
  const secondWorktreeId = 'worktree_44444444-4444-4444-8444-444444444444';

  it.each(['missing', 'foreign-owner', 'foreign-org'] as const)(
    'rejects every notification when a batch contains a %s workspace',
    async inaccessible => {
      if (inaccessible !== 'missing') {
        await client.db.execute(sql`
          INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id, organization_id)
          VALUES (
            ${secondWorktreeId},
            ${inaccessible === 'foreign-owner' ? otherOwner : owner},
            ${inaccessible === 'foreign-org' ? organizationId : null}
          )
        `);
      }
      expect((await notify(null, owner, [worktreeId, secondWorktreeId])).status).toBe(404);
      expect(notifyWorkspaceUpdates).not.toHaveBeenCalled();
    }
  );

  it('authorizes 200 owned workspaces with one query before one batch RPC', async () => {
    const worktreeIds = Array.from(
      { length: 200 },
      (_, index) => `worktree_${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
    );
    await client.db.execute(sql`
      INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id)
      SELECT id, ${owner}
      FROM unnest(ARRAY[${sql.join(
        worktreeIds.map(id => sql`${id}`),
        sql`, `
      )}]::text[]) AS id
    `);
    const select = vi.spyOn(client.db, 'select');
    try {
      const response = await notify(null, owner, worktreeIds);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ delivered: 2 });
      expect(select).toHaveBeenCalledTimes(1);
      expect(notifyWorkspaceUpdates.mock.calls).toEqual([[worktreeIds]]);
    } finally {
      select.mockRestore();
    }
  });
});

describe('new root workspace activity', () => {
  const input = {
    sessionId,
    kiloUserId: owner,
    cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    cloudAgentWorktreeId: worktreeId,
    createdOnPlatform: 'cloud-agent-web',
  } as const;

  it('advances activity when a new root joins an existing workspace', async () => {
    await rpc.createSessionForCloudAgent(input);
    const session = await client.db.execute<{ created_at: string }>(sql`
      SELECT created_at FROM pg_temp.cli_sessions_v2 WHERE session_id = ${sessionId}
    `);
    expect(new Date(String((await readWorkspace())?.last_activity_at)).getTime()).toBe(
      new Date(session.rows[0].created_at).getTime()
    );
    await Promise.all(pending);
    expect(notifySessionEvent).toHaveBeenLastCalledWith({
      type: 'workspace.updated',
      data: { worktreeId },
    });
  });

  it('does not count an idempotent root claim as activity', async () => {
    await rpc.createSessionForCloudAgent(input);
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees SET last_activity_at = ${oldActivity}
    `);
    await rpc.createSessionForCloudAgent(input);
    expect(new Date(String((await readWorkspace())?.last_activity_at)).toISOString()).toBe(
      oldActivity
    );
  });

  it('does not replace newer workspace activity or bump after a refused identity claim', async () => {
    const future = '2099-01-01T00:00:00.000Z';
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees SET last_activity_at = ${future}
    `);
    await rpc.createSessionForCloudAgent(input);
    await expect(
      rpc.createSessionForCloudAgent({
        ...input,
        cloudAgentSessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow('identity conflict');
    expect(new Date(String((await readWorkspace())?.last_activity_at)).toISOString()).toBe(future);
  });

  it('removes rollback roots from both tab arrays in the deleting transaction', async () => {
    await rpc.createSessionForCloudAgent(input);
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees
      SET closed_session_ids = ARRAY[${sessionId}, 'unrelated'],
        tab_order = ARRAY['unrelated', ${sessionId}]
    `);
    await rpc.deleteSessionForCloudAgent({ sessionId, kiloUserId: owner });
    expect(await readWorkspace()).toMatchObject({
      closed_session_ids: ['unrelated'],
      tab_order: ['unrelated'],
    });
    const sessions = await client.db.execute(sql`SELECT session_id FROM pg_temp.cli_sessions_v2`);
    expect(sessions.rows).toEqual([]);
  });
});
