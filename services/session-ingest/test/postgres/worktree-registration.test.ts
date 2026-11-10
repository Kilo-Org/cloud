import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, type DrizzleClient } from '@kilocode/db/client';
import { cloud_agent_worktrees } from '@kilocode/db/schema';
import type { CreateSessionForCloudAgentParams } from '@kilocode/session-ingest-contracts';
import { eq, sql } from 'drizzle-orm';
import { registerCloudAgentWorktree } from '../../src/services/worktree-deletion';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../../src/dos/SessionIngestDO', () => ({ getSessionIngestDO: vi.fn() }));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../../src/dos/UserConnectionDO', () => ({ getUserConnectionDO: vi.fn() }));

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const gitUrl = 'https://github.com/acme/widgets';
const params = {
  sessionId: 'ses_11111111111111111111111111',
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  cloudAgentWorktreeId: worktreeId,
  kiloUserId: 'oauth/worktree-registration-test',
  createdOnPlatform: 'cloud-agent-web',
} satisfies CreateSessionForCloudAgentParams;
let client: DrizzleClient;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('Worktree registration tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  // Include the primary key so ON CONFLICT exercises the real insert-only boundary.
  await client.db.execute(sql`
    CREATE TEMP TABLE cloud_agent_worktrees (
      LIKE public.cloud_agent_worktrees INCLUDING DEFAULTS INCLUDING INDEXES
    )
  `);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cloud_agent_worktrees`);
});

async function readWorktree() {
  const [row] = await client.db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return row;
}

describe('registerCloudAgentWorktree checkout', () => {
  it.each([
    'https://github.com/ACME/Widgets.git',
    'git@github.com:ACME/Widgets.git',
    'ssh://git@github.com/ACME/Widgets.git',
  ])('records the initial branch and canonical repository from %s', async repository => {
    await registerCloudAgentWorktree(client.db, {
      ...params,
      gitUrl: repository,
      gitBranch: 'kilo/eager-hub-j9o',
      baseBranch: 'main',
    });

    expect(await readWorktree()).toMatchObject({
      git_url: gitUrl,
      git_branch: 'kilo/eager-hub-j9o',
      base_branch: 'main',
    });
  });

  it('does not overwrite the checkout on retries or sibling registrations', async () => {
    const first = {
      ...params,
      gitUrl,
      gitBranch: 'kilo/first',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
    };
    await registerCloudAgentWorktree(client.db, first);
    await registerCloudAgentWorktree(client.db, {
      ...first,
      gitUrl: 'https://github.com/acme/other',
      gitBranch: 'kilo/retry',
      baseBranch: 'develop',
    });
    await registerCloudAgentWorktree(client.db, {
      ...params,
      sessionId: 'ses_22222222222222222222222222',
      cloudAgentSessionId: 'workspace_22222222-2222-4222-8222-222222222222',
    });

    expect(await readWorktree()).toMatchObject({
      git_url: gitUrl,
      git_branch: 'kilo/first',
      base_branch: 'main',
      base_sha: first.baseSha,
    });
  });

  it.each([{}, { gitUrl }, { gitBranch: 'kilo/first' }])(
    'requires both repository and branch on the initial registration: %j',
    async checkout => {
      await registerCloudAgentWorktree(client.db, { ...params, ...checkout });
      expect(await readWorktree()).toMatchObject({ git_url: null, git_branch: null });

      await registerCloudAgentWorktree(client.db, {
        ...params,
        gitUrl,
        gitBranch: 'kilo/later',
      });
      expect(await readWorktree()).toMatchObject({ git_url: null, git_branch: null });
    }
  );

  it('does not record the base branch as the workspace branch', async () => {
    await registerCloudAgentWorktree(client.db, {
      ...params,
      gitUrl,
      gitBranch: 'main',
      baseBranch: 'main',
    });
    expect(await readWorktree()).toMatchObject({
      git_url: null,
      git_branch: null,
      base_branch: 'main',
    });
  });
});
