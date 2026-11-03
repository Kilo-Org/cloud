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

import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  WORKSPACE_DELETING,
  WORKSPACE_IDENTITY_CONFLICT,
  WORKSPACE_REQUIRES_ROOT_SESSION,
} from '@kilocode/session-ingest-contracts';
import {
  assertHostedWorkspaceSessionDeletable,
  deleteHostedWorkspaceSessionRows,
} from '../../src/services/hosted-workspace-session';

const userId = 'oauth/hosted-workspace-delete-owner';
const otherUserId = 'oauth/hosted-workspace-delete-other';
const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const secondWorkspaceId = 'worktree_22222222-2222-4222-8222-222222222222';
const rootKiloSessionId = 'ses_11111111111111111111111111';
const rootCloudSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const siblingKiloSessionId = 'ses_22222222222222222222222222';
const siblingCloudSessionId = 'workspace_22222222-2222-4222-8222-222222222222';
const childKiloSessionId = 'ses_33333333333333333333333333';
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The hosted workspace deletion tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  await client.db.execute(sql`
    CREATE TEMP TABLE cloud_agent_worktrees (
      worktree_id text PRIMARY KEY,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      deletion_started_at timestamptz
    );
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      organization_id uuid,
      parent_session_id text,
      cloud_agent_session_id text,
      cloud_agent_worktree_id text,
      git_url text,
      git_branch text,
      created_on_platform text NOT NULL DEFAULT 'agent-manager',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`
    TRUNCATE pg_temp.cli_sessions_v2, pg_temp.cloud_agent_worktrees
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id, organization_id)
    VALUES (${workspaceId}, ${userId}, NULL)
  `);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, parent_session_id, cloud_agent_session_id, cloud_agent_worktree_id
    ) VALUES
      (${rootKiloSessionId}, ${userId}, NULL, ${rootCloudSessionId}, ${workspaceId}),
      (${siblingKiloSessionId}, ${userId}, NULL, ${siblingCloudSessionId}, ${workspaceId}),
      (${childKiloSessionId}, ${userId}, ${siblingKiloSessionId}, NULL, ${workspaceId})
  `);
});

async function readSessionIds(): Promise<string[]> {
  const result = await client.db.execute<{ session_id: string }>(sql`
    SELECT session_id FROM pg_temp.cli_sessions_v2 ORDER BY session_id
  `);
  return result.rows.map(row => row.session_id);
}

describe('deleteHostedWorkspaceSessionRows', () => {
  it('deletes one middle root and its descendants while preserving the workspace and siblings', async () => {
    const outcome = await deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
      kiloUserId: userId,
      workspaceId,
      sessionId: siblingKiloSessionId,
      cloudAgentSessionId: siblingCloudSessionId,
    });

    expect(outcome.deleted).toBe(true);
    expect(outcome.deletedSessionIds).toEqual([childKiloSessionId, siblingKiloSessionId]);
    expect(await readSessionIds()).toEqual([rootKiloSessionId]);
    const worktrees = await client.db.execute<{ worktree_id: string }>(sql`
      SELECT worktree_id FROM pg_temp.cloud_agent_worktrees
    `);
    expect(worktrees.rows).toEqual([{ worktree_id: workspaceId }]);
  });

  it('rejects deleting the final hosted root and leaves the session intact', async () => {
    await deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
      kiloUserId: userId,
      workspaceId,
      sessionId: siblingKiloSessionId,
      cloudAgentSessionId: siblingCloudSessionId,
    });

    await expect(
      deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
        kiloUserId: userId,
        workspaceId,
        sessionId: rootKiloSessionId,
        cloudAgentSessionId: rootCloudSessionId,
      })
    ).rejects.toMatchObject({
      code: WORKSPACE_REQUIRES_ROOT_SESSION,
    });
    expect(await readSessionIds()).toEqual([rootKiloSessionId]);
  });

  it('rejects a session that does not belong to the requested workspace', async () => {
    await client.db.execute(sql`
      INSERT INTO pg_temp.cloud_agent_worktrees (worktree_id, kilo_user_id)
      VALUES (${secondWorkspaceId}, ${userId})
    `);

    await expect(
      deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
        kiloUserId: userId,
        workspaceId: secondWorkspaceId,
        sessionId: rootKiloSessionId,
        cloudAgentSessionId: rootCloudSessionId,
      })
    ).rejects.toMatchObject({
      code: WORKSPACE_IDENTITY_CONFLICT,
    });
    expect(await readSessionIds()).toHaveLength(3);
  });

  it('rejects deletion while the workspace is being destroyed', async () => {
    await client.db.execute(sql`
      UPDATE pg_temp.cloud_agent_worktrees
      SET deletion_started_at = now()
      WHERE worktree_id = ${workspaceId}
    `);

    await expect(
      deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
        kiloUserId: userId,
        workspaceId,
        sessionId: siblingKiloSessionId,
        cloudAgentSessionId: siblingCloudSessionId,
      })
    ).rejects.toMatchObject({
      code: WORKSPACE_DELETING,
    });
    expect(await readSessionIds()).toHaveLength(3);
  });

  it('does not delete rows owned by another user', async () => {
    const outcome = await deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
      kiloUserId: otherUserId,
      workspaceId,
      sessionId: siblingKiloSessionId,
      cloudAgentSessionId: siblingCloudSessionId,
    });

    expect(outcome.deleted).toBe(false);
    expect(await readSessionIds()).toHaveLength(3);
  });
});

describe('assertHostedWorkspaceSessionDeletable', () => {
  it('returns the workspace for a middle root', async () => {
    await expect(
      assertHostedWorkspaceSessionDeletable(client.db as unknown as WorkerDb, {
        kiloUserId: userId,
        sessionId: siblingKiloSessionId,
        cloudAgentSessionId: siblingCloudSessionId,
      })
    ).resolves.toEqual({ workspaceId });
  });

  it('rejects the final root', async () => {
    await deleteHostedWorkspaceSessionRows(client.db as unknown as WorkerDb, {
      kiloUserId: userId,
      workspaceId,
      sessionId: siblingKiloSessionId,
      cloudAgentSessionId: siblingCloudSessionId,
    });

    await expect(
      assertHostedWorkspaceSessionDeletable(client.db as unknown as WorkerDb, {
        kiloUserId: userId,
        sessionId: rootKiloSessionId,
        cloudAgentSessionId: rootCloudSessionId,
      })
    ).rejects.toMatchObject({
      code: WORKSPACE_REQUIRES_ROOT_SESSION,
    });
  });
});
