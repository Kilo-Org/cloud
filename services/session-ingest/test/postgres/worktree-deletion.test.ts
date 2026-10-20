import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  WORKTREE_MERGED_PULL_REQUESTS_REQUIRED,
  type CloudAgentWorktreeDeletionParams,
} from '@kilocode/session-ingest-contracts';
import { beginWorktreeDeletion, recordWorktreeCleanup } from '../../src/services/worktree-deletion';
import type { Env } from '../../src/env';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), snapshot: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock(import('@kilocode/db/client'), async importOriginal => ({
  ...(await importOriginal()),
  getWorkerDb: mocks.getDb,
}));
vi.mock(import('@kilocode/worker-utils'), async importOriginal => ({
  ...(await importOriginal()),
  hasOrganizationAccess: async () => true,
}));
vi.mock('../../src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: () => ({ readKiloSdkSessionSnapshot: mocks.snapshot }),
}));
vi.mock('../../src/dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));
vi.mock('../../src/dos/UserConnectionDO', () => ({ getUserConnectionDO: vi.fn() }));

const userId = 'oauth/github:merged-cleanup';
const organizationId = '33333333-3333-4333-8333-333333333333';
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const rootId = `ses_${'0'.repeat(26)}`;
const childId = `ses_${'1'.repeat(26)}`;
const gitUrl = 'https://github.com/example/repository';
const directory = `/workspace/owner/worktrees/${worktreeId}`;
const params = {
  kiloUserId: userId,
  worktreeId,
  requireMergedPullRequests: true,
} satisfies CloudAgentWorktreeDeletionParams;
const env = { HYPERDRIVE: { connectionString: 'unused' } } as Env;
let client: ReturnType<typeof createDrizzleClient>;

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a local test database');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) {
    throw new Error('The deletion tests require a local PostgreSQL database');
  }
  client = createDrizzleClient({ connectionString, poolConfig: { max: 1 }, ssl: false });
  for (const table of [cli_sessions_v2, cloud_agent_worktrees, github_branch_pull_requests]) {
    await client.db.execute(sql`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  mocks.getDb.mockReturnValue(client.db);
});

afterAll(async () => {
  if (client) await client.pool.end();
});

beforeEach(async () => {
  await client.db.execute(sql`TRUNCATE pg_temp.cli_sessions_v2,
    pg_temp.cloud_agent_worktrees, pg_temp.github_branch_pull_requests`);
  mocks.snapshot.mockReset();
  mocks.snapshot.mockResolvedValue({ kind: 'pending' });
  await client.db.insert(cloud_agent_worktrees).values({
    worktree_id: worktreeId,
    kilo_user_id: userId,
    runtime_locations: [{ sandboxId: 'sandbox', provider: 'cloudflare' }],
  });
  await client.db.insert(cli_sessions_v2).values({
    session_id: rootId,
    kilo_user_id: userId,
    cloud_agent_session_id: cloudAgentSessionId,
    cloud_agent_worktree_id: worktreeId,
    git_url: gitUrl,
    platform: 'github',
    pr_url: `${gitUrl}/pull/1`,
    pr_number: 1,
    pr_link_verified_at: '2026-10-20 01:00:00+00',
  });
  await client.db.insert(github_branch_pull_requests).values({
    git_url: gitUrl,
    git_branch: 'old-reused-branch',
    owned_by_user_id: userId,
    pr_number: 1,
    pr_state: 'merged',
  });
});

async function worktree() {
  const [row] = await client.db.select().from(cloud_agent_worktrees);
  return row;
}

async function addChild(values: Partial<typeof cli_sessions_v2.$inferInsert> = {}) {
  await client.db.insert(cli_sessions_v2).values({
    session_id: childId,
    kilo_user_id: userId,
    git_url: gitUrl,
    platform: 'github',
    pr_url: `${gitUrl}/pull/2`,
    pr_number: 2,
    pr_link_verified_at: '2026-10-20 01:00:00+00',
    ...values,
  });
  await client.db.insert(github_branch_pull_requests).values({
    git_url: gitUrl,
    git_branch: 'new-branch',
    owned_by_user_id: userId,
    pr_number: 2,
    pr_state: 'open',
  });
}

describe('merged-only deletion transactions', () => {
  it('rejects a queued worktree that acquired an open-PR root before deletion, without fencing it', async () => {
    await addChild({
      cloud_agent_worktree_id: worktreeId,
      cloud_agent_session_id: 'workspace_22222222-2222-4222-8222-222222222222',
    });
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    expect(await worktree()).toMatchObject({ deletion_started_at: null, deletion_manifest: null });
  });

  it.each(['parent', 'scope'])('rejects an open-PR descendant linked only by %s', async linkage => {
    await addChild(
      linkage === 'parent'
        ? { parent_session_id: rootId }
        : { cloud_agent_session_scope_id: cloudAgentSessionId }
    );
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    expect((await worktree()).deletion_started_at).toBeNull();
  });

  it('revalidates persisted members on retry even when their parent link is no longer discoverable', async () => {
    await addChild({ parent_session_id: rootId, pr_url: null, pr_number: null });
    await beginWorktreeDeletion(env, params);
    const journal = await worktree();
    await client.db
      .update(cli_sessions_v2)
      .set({ parent_session_id: null, pr_url: `${gitUrl}/pull/2`, pr_number: 2 })
      .where(eq(cli_sessions_v2.session_id, childId));
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    expect(await worktree()).toEqual(journal);
  });

  it.each(['scope', 'snapshot', 'retained'])(
    'rejects newly discovered %s members before runtime cleanup and preserves recovery state',
    async linkage => {
      await beginWorktreeDeletion(env, params);
      const journal = await worktree();
      await addChild(
        linkage === 'scope' ? { cloud_agent_session_scope_id: cloudAgentSessionId } : {}
      );
      if (linkage === 'snapshot') {
        mocks.snapshot.mockResolvedValue({
          kind: 'value',
          info: {
            id: childId,
            parentID: rootId,
            directory,
            slug: 'child',
            projectID: 'project',
            title: 'Orphan',
            version: '7.4.20',
            time: { created: 1, updated: 1 },
          },
          byteLength: 100,
        });
      }
      await expect(
        recordWorktreeCleanup(env, {
          ...params,
          directory,
          ...(linkage === 'retained'
            ? {
                childSessions: [
                  { sessionId: childId, parentSessionId: rootId, cloudAgentSessionId },
                ],
              }
            : {}),
        })
      ).rejects.toThrow(WORKTREE_MERGED_PULL_REQUESTS_REQUIRED);
      expect(await worktree()).toEqual(journal);
      const [child] = await client.db
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, childId));
      expect(child.cloud_agent_worktree_id).toBeNull();
      expect(child.parent_session_id).toBeNull();
    }
  );

  it.each([
    'open',
    'closed',
    'unknown',
    'unverified',
    'nonGithub',
    'number-only',
    'url-only',
    'no-linked-pr',
  ])('fails closed for %s links', async problem => {
    if (['open', 'closed', 'unknown'].includes(problem)) {
      await client.db.update(github_branch_pull_requests).set({ pr_state: problem });
    } else {
      await client.db.update(cli_sessions_v2).set({
        ...(problem === 'unverified' ? { pr_link_verified_at: null } : {}),
        ...(problem === 'nonGithub' ? { platform: 'gitlab' } : {}),
        ...(problem === 'number-only' ? { pr_url: null } : {}),
        ...(problem === 'url-only' ? { pr_number: null } : {}),
        ...(problem === 'no-linked-pr' ? { pr_url: null, pr_number: null } : {}),
      });
    }
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    expect((await worktree()).deletion_started_at).toBeNull();
  });

  it.each(['user', 'organization', 'git-url', 'pr-number'])(
    'does not borrow a merged cache entry with mismatched %s identity',
    async identity => {
      await client.db.update(github_branch_pull_requests).set({
        ...(identity === 'user' ? { owned_by_user_id: 'another-user' } : {}),
        ...(identity === 'organization'
          ? { owned_by_user_id: null, owned_by_organization_id: organizationId }
          : {}),
        ...(identity === 'git-url' ? { git_url: 'https://github.com/other/repo' } : {}),
        ...(identity === 'pr-number' ? { pr_number: 2 } : {}),
      });
      await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
        WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
      );
    }
  );

  it('uses the organization cache rather than personal state for organization sessions', async () => {
    await client.db.update(cli_sessions_v2).set({ organization_id: organizationId });
    await client.db.update(cloud_agent_worktrees).set({ organization_id: organizationId });
    const scoped = { ...params, organizationId };
    await expect(beginWorktreeDeletion(env, scoped)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    await client.db
      .update(github_branch_pull_requests)
      .set({ owned_by_user_id: null, owned_by_organization_id: organizationId });
    await expect(beginWorktreeDeletion(env, scoped)).resolves.toMatchObject({ completed: false });
  });

  it('checks recovered tenant identity before lineage repair could move a personal PR into an organization', async () => {
    await client.db.update(cli_sessions_v2).set({ organization_id: organizationId });
    await client.db.update(cloud_agent_worktrees).set({ organization_id: organizationId });
    await client.db.update(github_branch_pull_requests).set({
      owned_by_user_id: null,
      owned_by_organization_id: organizationId,
    });
    const scoped = { ...params, organizationId };
    await beginWorktreeDeletion(env, scoped);
    await addChild();
    await client.db.insert(github_branch_pull_requests).values({
      git_url: gitUrl,
      git_branch: 'organization-branch',
      owned_by_organization_id: organizationId,
      pr_number: 2,
      pr_state: 'merged',
    });
    await expect(
      recordWorktreeCleanup(env, {
        ...scoped,
        childSessions: [{ sessionId: childId, parentSessionId: rootId, cloudAgentSessionId }],
      })
    ).rejects.toThrow(WORKTREE_MERGED_PULL_REQUESTS_REQUIRED);
    const [child] = await client.db
      .select()
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.session_id, childId));
    expect(child.organization_id).toBeNull();
    expect(child.cloud_agent_worktree_id).toBeNull();
  });

  it('allows verified merged links independent of branch names and includes unlinked descendants', async () => {
    await addChild({
      cloud_agent_session_scope_id: cloudAgentSessionId,
      pr_url: null,
      pr_number: null,
    });
    await client.db.update(cli_sessions_v2).set({ git_branch: 'different-new-branch' });
    const state = await beginWorktreeDeletion(env, params);
    expect(state.manifest.sessions.map(session => session.sessionId)).toEqual([rootId, childId]);
    await expect(recordWorktreeCleanup(env, params)).resolves.toMatchObject({ completed: false });
  });

  it('keeps individual deletion unrestricted even after a rejected merged-only attempt', async () => {
    await client.db.update(github_branch_pull_requests).set({ pr_state: 'open' });
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      WORKTREE_MERGED_PULL_REQUESTS_REQUIRED
    );
    await expect(
      beginWorktreeDeletion(env, { worktreeId, kiloUserId: userId })
    ).resolves.toMatchObject({ completed: false });
  });
});
