import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { persistWorkspaceActivity } from '../../src/services/workspace-activity';

const userId = 'oauth/workspace-activity-test';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)
  )
    throw new Error('Workspace activity tests require local PostgreSQL');
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  await client.db.execute(
    sql`CREATE TEMP TABLE cloud_agent_worktrees (LIKE public.cloud_agent_worktrees INCLUDING DEFAULTS)`
  );
  await client.db.execute(
    sql`CREATE TEMP TABLE cli_sessions_v2 (LIKE public.cli_sessions_v2 INCLUDING DEFAULTS)`
  );
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cloud_agent_worktrees, pg_temp.cli_sessions_v2`);
  await client.db
    .insert(cloud_agent_worktrees)
    .values({ worktree_id: worktreeId, kilo_user_id: userId });
  await client.db
    .insert(cli_sessions_v2)
    .values({ session_id: 'root', kilo_user_id: userId, cloud_agent_worktree_id: worktreeId });
});

async function activity() {
  const [row] = await client.db
    .select({
      at: cloud_agent_worktrees.last_activity_at,
      updated: cloud_agent_worktrees.updated_at,
    })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return row;
}

it('advances activity for root chats without rewriting equal or older activity', async () => {
  await persistWorkspaceActivity(client.db, userId, 'root', '2026-11-16T11:00:00Z');
  await client.db.update(cloud_agent_worktrees).set({ updated_at: '2026-01-01T00:00:00Z' });
  await persistWorkspaceActivity(client.db, userId, 'root', '2026-11-16T10:00:00Z');
  await persistWorkspaceActivity(client.db, userId, 'root', '2026-11-16T11:00:00Z');
  expect(new Date((await activity())?.at ?? '').toISOString()).toBe('2026-11-16T11:00:00.000Z');
  expect(new Date((await activity())?.updated ?? '').toISOString()).toBe(
    '2026-01-01T00:00:00.000Z'
  );
});

it('ignores children, missing chats, and another owner', async () => {
  await client.db.insert(cli_sessions_v2).values({
    session_id: 'child',
    parent_session_id: 'root',
    kilo_user_id: userId,
    cloud_agent_worktree_id: worktreeId,
  });
  for (const sessionId of ['child', 'missing'])
    await persistWorkspaceActivity(client.db, userId, sessionId, '2026-11-16T11:00:00Z');
  await persistWorkspaceActivity(client.db, 'oauth/other-owner', 'root', '2026-11-16T11:00:00Z');
  expect((await activity())?.at).toBeNull();
});

it('ignores mismatched organization membership and deleting workspaces', async () => {
  await client.db
    .update(cli_sessions_v2)
    .set({ organization_id: '22222222-2222-4222-8222-222222222222' });
  await persistWorkspaceActivity(client.db, userId, 'root', '2026-11-16T11:00:00Z');
  expect((await activity())?.at).toBeNull();
  await client.db.update(cli_sessions_v2).set({ organization_id: null });
  await client.db
    .update(cloud_agent_worktrees)
    .set({ deletion_started_at: '2026-11-16T10:00:00Z' });
  await persistWorkspaceActivity(client.db, userId, 'root', '2026-11-16T11:00:00Z');
  expect((await activity())?.at).toBeNull();
});
