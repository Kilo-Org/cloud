import type * as DbClient from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClient>();
  return { ...actual, getWorkerDb: vi.fn() };
});

vi.mock('../../src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(() => {
    throw new Error('Workspace catalog must not access SessionIngestDO');
  }),
  CLONE_ITEM_TYPES: ['session', 'message', 'part', 'session_diff'],
}));

import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from '../../src/dos/SessionIngestDO';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';

const userId = 'oauth/workspace-catalog-owner';
const otherUserId = 'oauth/workspace-catalog-other';
const organizationId = '11111111-1111-4111-8111-111111111111';
const firstWorkspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const secondWorkspaceId = 'worktree_22222222-2222-4222-8222-222222222222';
const deletedWorkspaceId = 'worktree_33333333-3333-4333-8333-333333333333';
let client: ReturnType<typeof createDrizzleClient>;
let rpc: SessionIngestRPC;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The workspace catalog tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  rpc = new SessionIngestRPC(
    { waitUntil() {}, passThroughOnException() {} } as never,
    { HYPERDRIVE: { connectionString } } as never
  );
  await client.db.execute(sql`
    CREATE TEMP TABLE organizations (
      id uuid PRIMARY KEY,
      parent_organization_id uuid,
      deleted_at timestamptz
    );
    CREATE TEMP TABLE organization_memberships (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      kilo_user_id text NOT NULL,
      role text NOT NULL
    );
    CREATE TEMP TABLE cloud_agent_worktrees (
      worktree_id text PRIMARY KEY,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      name text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      deletion_started_at timestamptz,
      deletion_completed_at timestamptz
    );
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      parent_session_id text,
      cloud_agent_session_id text,
      cloud_agent_worktree_id text,
      title text,
      git_url text,
      git_branch text,
      profile_id uuid,
      created_on_platform text NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      last_activity_at timestamptz,
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`
    TRUNCATE pg_temp.cli_sessions_v2, pg_temp.cloud_agent_worktrees,
      pg_temp.organization_memberships, pg_temp.organizations
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.organizations (id, parent_organization_id, deleted_at)
    VALUES (${organizationId}, NULL, NULL)
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.organization_memberships (id, organization_id, kilo_user_id, role)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ${organizationId}, ${userId}, 'member')
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cloud_agent_worktrees (
      worktree_id, kilo_user_id, organization_id, name, created_at, updated_at,
      deletion_started_at, deletion_completed_at
    ) VALUES
      (${firstWorkspaceId}, ${userId}, ${organizationId}, 'First', '2026-01-01', '2026-01-05', NULL, NULL),
      (${secondWorkspaceId}, ${userId}, NULL, 'Second', '2026-01-02', '2026-01-06', '2026-01-07', NULL),
      (${deletedWorkspaceId}, ${userId}, NULL, NULL, '2026-01-03', '2026-01-08', '2026-01-07', '2026-01-08')
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, organization_id, parent_session_id,
      cloud_agent_session_id, cloud_agent_worktree_id, title, git_url, git_branch,
      profile_id, created_on_platform, created_at, updated_at, last_activity_at
    ) VALUES
      ('ses_11111111111111111111111111', ${userId}, ${organizationId}, NULL,
       'workspace_root_1', ${firstWorkspaceId}, 'Canonical', 'https://github.com/acme/repo',
       'main', NULL, 'cloud-agent-web', '2026-01-01', '2026-01-04', '2026-01-04'),
      ('ses_22222222222222222222222222', ${userId}, ${organizationId}, NULL,
       'workspace_root_2', ${firstWorkspaceId}, 'Sibling', 'https://gitlab.com/acme/other',
       'feature', NULL, 'cloud-agent-web', '2026-01-02', '2026-01-05', '2026-01-05'),
      ('ses_33333333333333333333333333', ${userId}, NULL, NULL,
       'workspace_root_3', ${secondWorkspaceId}, 'Second root', 'https://github.com/acme/repo',
       'main', NULL, 'cloud-agent-web', '2026-01-02', '2026-01-06', '2026-01-06'),
      ('ses_44444444444444444444444444', ${userId}, ${organizationId},
       'ses_11111111111111111111111111', NULL, ${firstWorkspaceId}, 'Child',
       'https://github.com/acme/repo', 'main', NULL, 'cloud-agent-web',
       '2026-01-03', '2026-01-07', '2026-01-07'),
      ('ses_55555555555555555555555555', ${otherUserId}, NULL, NULL,
       'workspace_other', 'worktree_55555555-5555-4555-8555-555555555555', 'Other',
       'https://github.com/acme/repo', 'main', NULL, 'cloud-agent-web',
       '2026-01-03', '2026-01-07', '2026-01-07')
  `);
});

describe('hosted workspace catalog PostgreSQL queries', () => {
  it('groups roots, excludes children and tombstones, and filters by canonical root repository', async () => {
    const page = await rpc.listCloudAgentWorkspaces({
      kiloUserId: userId,
      repositoryUrl: 'git@github.com:ACME/REPO.git',
      sessionLimit: 10,
    });

    expect(page.items.map(item => item.workspaceId)).toEqual([secondWorkspaceId, firstWorkspaceId]);
    expect(page.items[0]).toMatchObject({
      deletionState: 'deleting',
      repositoryProvider: 'github',
    });
    expect(page.items[1]).toMatchObject({
      gitUrl: 'https://github.com/acme/repo',
      gitBranch: 'main',
      deletionState: 'active',
      sessions: [
        { workspaceId: firstWorkspaceId, title: 'Sibling' },
        { workspaceId: firstWorkspaceId, title: 'Canonical' },
      ],
    });
    await expect(
      rpc.listCloudAgentWorkspaces({
        kiloUserId: userId,
        repositoryUrl: 'https://gitlab.com/acme/other',
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('revokes organization visibility immediately and denies workspace ID guessing', async () => {
    await expect(
      rpc.getCloudAgentWorkspace({ kiloUserId: userId, workspaceId: firstWorkspaceId })
    ).resolves.toMatchObject({ workspaceId: firstWorkspaceId });

    await client.db.execute(sql`
      DELETE FROM pg_temp.organization_memberships
      WHERE organization_id = ${organizationId} AND kilo_user_id = ${userId}
    `);

    await expect(
      rpc.getCloudAgentWorkspace({ kiloUserId: userId, workspaceId: firstWorkspaceId })
    ).resolves.toBeNull();
    await expect(
      rpc.getCloudAgentWorkspace({ kiloUserId: otherUserId, workspaceId: secondWorkspaceId })
    ).resolves.toBeNull();
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('excludes completed tombstones from lists but returns an authorized tombstone by ID', async () => {
    await expect(rpc.listCloudAgentWorkspaces({ kiloUserId: userId })).resolves.toMatchObject({
      items: expect.not.arrayContaining([
        expect.objectContaining({ workspaceId: deletedWorkspaceId }),
      ]),
    });
    await expect(
      rpc.getCloudAgentWorkspace({ kiloUserId: userId, workspaceId: deletedWorkspaceId })
    ).resolves.toMatchObject({
      workspaceId: deletedWorkspaceId,
      deletionState: 'deleted',
      sessions: [],
    });
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });
});
