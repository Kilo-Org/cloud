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

import { createDrizzleClient, getWorkerDb } from '@kilocode/db/client';
import {
  hasSurvivingHostedRoot,
  hostedRootIdentity,
  WORKSPACE_REQUIRES_ROOT_SESSION,
} from '../../src/services/hosted-root-guard';
import { SessionIngestRPC } from '../../src/session-ingest-rpc';

const userId = 'oauth/root-guard-owner';
const otherUserId = 'oauth/root-guard-other';
const firstWorkspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const loneWorkspaceId = 'worktree_33333333-3333-4333-8333-333333333333';
const foreignWorkspaceId = 'worktree_44444444-4444-4444-8444-444444444444';

const rootA = 'ses_11111111111111111111111111';
const rootB = 'ses_22222222222222222222222222';
const rootLone = 'ses_33333333333333333333333333';
const foreignRoot = 'ses_44444444444444444444444444';
const childA = 'ses_55555555555555555555555555';

let client: ReturnType<typeof createDrizzleClient>;
let rpc: SessionIngestRPC;

async function identityOf(sessionId: string) {
  const [row] = await client.db
    .execute<{
      cloud_agent_session_id: string | null;
      cloud_agent_worktree_id: string | null;
      cloud_agent_session_scope_id: string | null;
    }>(sql`
    SELECT cloud_agent_session_id, cloud_agent_worktree_id, cloud_agent_session_scope_id
    FROM pg_temp.cli_sessions_v2
    WHERE session_id = ${sessionId}
  `)
    .then(result => result.rows);
  return row ? hostedRootIdentity(row) : null;
}

async function guardAllows(sessionId: string, owner = userId): Promise<boolean> {
  const identity = await identityOf(sessionId);
  if (!identity) return false;
  return hasSurvivingHostedRoot(client.db as never, owner, identity);
}

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The hosted root guard tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  vi.mocked(getWorkerDb).mockReturnValue(client.db);
  rpc = new SessionIngestRPC(
    { waitUntil() {}, passThroughOnException() {} } as never,
    { HYPERDRIVE: { connectionString } } as never
  );
  await client.db.execute(sql`
    CREATE TEMP TABLE cli_sessions_v2 (
      session_id text NOT NULL,
      kilo_user_id text NOT NULL,
      parent_session_id text,
      cloud_agent_session_id text,
      cloud_agent_worktree_id text,
      cloud_agent_session_scope_id text,
      PRIMARY KEY (session_id, kilo_user_id)
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2`);
  await client.db.execute(sql`
    INSERT INTO pg_temp.cli_sessions_v2 (
      session_id, kilo_user_id, parent_session_id, cloud_agent_session_id,
      cloud_agent_worktree_id, cloud_agent_session_scope_id
    ) VALUES
      (${rootA}, ${userId}, NULL, 'workspace_a', ${firstWorkspaceId}, 'workspace_a'),
      (${rootB}, ${userId}, NULL, 'workspace_b', ${firstWorkspaceId}, 'workspace_b'),
      (${rootLone}, ${userId}, NULL, 'workspace_lone', ${loneWorkspaceId}, 'workspace_lone'),
      (${foreignRoot}, ${otherUserId}, NULL, 'workspace_foreign', ${foreignWorkspaceId}, 'workspace_foreign'),
      (${childA}, ${userId}, ${rootA}, NULL, ${firstWorkspaceId}, 'workspace_a')
  `);
});

describe('hosted root deletion guard against real PostgreSQL', () => {
  it('sees roots sharing a workspace and ignores children', async () => {
    await expect(guardAllows(rootA)).resolves.toBe(true);
    await expect(guardAllows(rootB)).resolves.toBe(true);
  });

  it('never treats another user of the same workspace ID as a surviving sibling', async () => {
    await expect(guardAllows(rootLone)).resolves.toBe(false);
    await expect(guardAllows(foreignRoot)).resolves.toBe(false);
  });

  it('stops surviving once the remaining root is deleted', async () => {
    await client.db.execute(sql`DELETE FROM pg_temp.cli_sessions_v2 WHERE session_id = ${rootB}`);
    await expect(guardAllows(rootA)).resolves.toBe(false);
  });

  it('rejects deleting the final hosted root through the worker with a stable code', async () => {
    await expect(
      rpc.deleteSessionForCloudAgent({ sessionId: rootLone, kiloUserId: userId })
    ).rejects.toThrow(WORKSPACE_REQUIRES_ROOT_SESSION);

    const remaining = await client.db.execute<{ session_id: string }>(sql`
      SELECT session_id FROM pg_temp.cli_sessions_v2 WHERE session_id = ${rootLone}
    `);
    expect(remaining.rows).toHaveLength(1);
  });

  it('allows deleting a root while a sibling survives', async () => {
    await expect(guardAllows(rootA)).resolves.toBe(true);
    await expect(guardAllows(rootB)).resolves.toBe(true);
  });
});
