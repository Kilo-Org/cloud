import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cloud_agent_worktrees } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { recordWorkspaceCheckout } from '../../src/services/workspace-checkout';

const userId = 'oauth/workspace-checkout-test';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const gitUrl = 'https://github.com/acme/widgets';
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Workspace checkout tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  // A session-local copy of the table tests the real query without changing shared data.
  await client.db.execute(sql`
    CREATE TEMP TABLE cloud_agent_worktrees (LIKE public.cloud_agent_worktrees INCLUDING DEFAULTS)
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cloud_agent_worktrees`);
  await client.db
    .insert(cloud_agent_worktrees)
    .values({ worktree_id: worktreeId, kilo_user_id: userId });
});

async function readCheckout() {
  const [row] = await client.db
    .select({
      git_url: cloud_agent_worktrees.git_url,
      git_branch: cloud_agent_worktrees.git_branch,
      updated_at: cloud_agent_worktrees.updated_at,
    })
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return row;
}

describe('recordWorkspaceCheckout', () => {
  it('records the reported repository and branch, following a branch switch', async () => {
    await recordWorkspaceCheckout(client.db, userId, { worktreeId, gitUrl, gitBranch: 'kilo/one' });
    expect(await readCheckout()).toMatchObject({ git_url: gitUrl, git_branch: 'kilo/one' });

    await recordWorkspaceCheckout(client.db, userId, { worktreeId, gitUrl, gitBranch: 'kilo/two' });
    expect(await readCheckout()).toMatchObject({ git_url: gitUrl, git_branch: 'kilo/two' });
  });

  it('does not rewrite an unchanged checkout', async () => {
    await recordWorkspaceCheckout(client.db, userId, { worktreeId, gitUrl, gitBranch: 'kilo/one' });
    await client.db
      .update(cloud_agent_worktrees)
      .set({ updated_at: '2026-01-01T00:00:00.000Z' })
      .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));

    await recordWorkspaceCheckout(client.db, userId, { worktreeId, gitUrl, gitBranch: 'kilo/one' });

    expect(new Date((await readCheckout())!.updated_at).toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  it("does not write another user's or a deleting workspace", async () => {
    await recordWorkspaceCheckout(client.db, 'oauth/someone-else', {
      worktreeId,
      gitUrl,
      gitBranch: 'kilo/foreign',
    });
    expect((await readCheckout())?.git_branch).toBeNull();

    await client.db
      .update(cloud_agent_worktrees)
      .set({ deletion_started_at: '2026-01-01T00:00:00.000Z' })
      .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
    await recordWorkspaceCheckout(client.db, userId, {
      worktreeId,
      gitUrl,
      gitBranch: 'kilo/late',
    });
    expect((await readCheckout())?.git_branch).toBeNull();
  });
});
